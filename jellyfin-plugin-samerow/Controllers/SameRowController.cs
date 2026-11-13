// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Http;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging;
using SameRow.Plugin.Configuration;
using SameRow.Plugin.Services;

namespace SameRow.Plugin.Controllers;

/// <summary>
/// Admin-only API controller for SameRow Connect pairing, status, and lifecycle management.
/// </summary>
[ApiController]
[Route("SameRow")]
[Authorize(Policy = "RequiresElevation")]
[Produces("application/json")]
public class SameRowController : ControllerBase
{
    private static readonly SemaphoreSlim PairingLock = new(1, 1);
    private static PendingPairingAttempt? _currentPending;

    private readonly SameRowConnectorService _connectorService;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<SameRowController> _logger;

    public SameRowController(
        SameRowConnectorService connectorService,
        IHttpClientFactory httpClientFactory,
        ILogger<SameRowController> logger)
    {
        _connectorService = connectorService;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    /// <summary>
    /// Gets the current connection and pairing status of the SameRow plugin.
    /// </summary>
    [HttpGet("AccountBinding")]
    public async Task<ActionResult<object>> GetAccountBinding()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        if (!config.IsPaired) return Ok(new { sameRowEmail = "", jellyfinAccount = (object?)null });
        try
        {
            using var client = _httpClientFactory.CreateClient("SameRowCloud");
            using var request = new HttpRequestMessage(HttpMethod.Get, $"{config.GatewayUrl.TrimEnd('/')}/api/jellyfin-relay/account-binding");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", config.ConnectorToken);
            using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(8));
            using var response = await client.SendAsync(request, timeout.Token);
            if (!response.IsSuccessStatusCode) return StatusCode(503, new { error = "Account binding could not be checked." });
            var binding = await response.Content.ReadFromJsonAsync<JsonElement>(cancellationToken: timeout.Token);
            return Ok(binding);
        }
        catch { return StatusCode(503, new { error = "Account binding could not be checked." }); }
    }

    [HttpGet("Status")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> GetStatus()
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        var pending = _currentPending != null && !_currentPending.IsExpired ? _currentPending : null;

        return Ok(new
        {
            isPaired = config.IsPaired,
            connectionState = _connectorService.State.ToString(),
            gatewayUrl = config.GatewayUrl,
            connectorId = config.ConnectorId,
            sameRowWebUrl = config.SameRowWebUrl,
            serverFriendlyName = config.ServerFriendlyName,
            pairedAt = config.PairedAt,
            lastActivityAt = _connectorService.LastActivityAt,
            lastConnectedAt = _connectorService.LastConnectedAt,
            lastError = _connectorService.LastError,
            activeJobs = _connectorService.ActiveJobs,
            totalJobs = _connectorService.TotalJobs,
            totalBytes = _connectorService.TotalBytes,
            workerCount = config.WorkerCount,
            autoStart = config.AutoStart,
            sameRowControlUrl = config.SameRowControlUrl,
            rotationPending = !string.IsNullOrEmpty(config.PendingProtectedConnectorToken),
            pendingPairing = pending == null ? null : new
            {
                id = pending.Id,
                approvalUrl = pending.ApprovalUrl,
                expiresAt = pending.ExpiresAt
            }
        });
    }

    /// <summary>
    /// Initiates a new one-time pairing flow with SameRow Cloud.
    /// </summary>
    [HttpPost("Pair/Start")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> StartPairing([FromBody] StartPairingRequest? request)
    {
        var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        string webUrl = !string.IsNullOrWhiteSpace(request?.WebUrl) ? request.WebUrl.TrimEnd('/') : config.SameRowWebUrl;
        string controlUrl = !string.IsNullOrWhiteSpace(request?.ControlUrl) ? request.ControlUrl.TrimEnd('/') :
            (!string.IsNullOrWhiteSpace(config.SameRowControlUrl) ? config.SameRowControlUrl.TrimEnd('/') : "https://samerow-v2.onrender.com");

        if (!IsHttpsOrigin(webUrl) || !IsHttpsOrigin(controlUrl))
            return BadRequest(new { error = "Enter an HTTPS origin without a path, credentials, query, or fragment." });
        if (config.IsPaired) return Conflict(new { error = "Disconnect this server before pairing it again." });

        await PairingLock.WaitAsync();
        try
        {
            // Generate 32-byte cryptographic secret and sha256 claim
            byte[] secretBytes = RandomNumberGenerator.GetBytes(32);
            string secret = Convert.ToHexString(secretBytes).ToLowerInvariant();
            string claim = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(secret))).ToLowerInvariant();

            using var client = _httpClientFactory.CreateClient("SameRowCloud");
            var startUri = new Uri($"{controlUrl}/api/jellyfin-relay/approval/start");

            HttpResponseMessage response;
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                response = await client.PostAsJsonAsync(startUri, new { claim }, timeout.Token);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to connect to SameRow Cloud for pairing at {Uri}", startUri);
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    error = "Could not reach SameRow Cloud. Please check your internet connection and try again."
                });
            }

            using var responseScope = response;
            if (!response.IsSuccessStatusCode)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    error = "SameRow Cloud rejected pairing request. Please try again shortly."
                });
            }

            var startResult = await response.Content.ReadFromJsonAsync<StartApprovalResponse>();
            if (startResult == null || !System.Text.RegularExpressions.Regex.IsMatch(startResult.Id, "^[a-f0-9]{32}$"))
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    error = "Invalid pairing handshake response from SameRow Cloud."
                });
            }

            string id = startResult.Id;
            string approvalUrl = $"{webUrl}/#connector={id}";
            var expiresAt = DateTime.UtcNow.AddMinutes(10);

            _currentPending = new PendingPairingAttempt
            {
                Id = id,
                Secret = secret,
                ControlUrl = controlUrl,
                WebUrl = webUrl,
                ApprovalUrl = approvalUrl,
                ExpiresAt = expiresAt
            };

            return Ok(new
            {
                id,
                approvalUrl,
                expiresInSeconds = 600
            });
        }
        finally
        {
            PairingLock.Release();
        }
    }

    /// <summary>
    /// Checks if the administrator has approved the pairing on SameRow Web and claims the credential.
    /// </summary>
    [HttpPost("Pair/Claim")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    [ProducesResponseType(StatusCodes.Status202Accepted)]
    [ProducesResponseType(StatusCodes.Status410Gone)]
    [ProducesResponseType(StatusCodes.Status503ServiceUnavailable)]
    public async Task<IActionResult> ClaimPairing([FromBody] ClaimPairingRequest? request)
    {
        await PairingLock.WaitAsync();
        try
        {
            var pending = _currentPending;
            string targetId = request?.Id ?? pending?.Id ?? string.Empty;

            if (pending == null || pending.Id != targetId || pending.IsExpired)
            {
                return StatusCode(StatusCodes.Status410Gone, new
                {
                    status = "expired",
                    error = "Pairing session has expired or was not found. Please click Connect again."
                });
            }

            using var client = _httpClientFactory.CreateClient("SameRowCloud");
            var claimUri = new Uri($"{pending.ControlUrl}/api/jellyfin-relay/approval/claim");

            HttpResponseMessage response;
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                response = await client.PostAsJsonAsync(claimUri, new
                {
                    id = pending.Id,
                    secret = pending.Secret
                }, timeout.Token);
            }
            catch (Exception ex)
            {
                _logger.LogWarning(ex, "Failed to contact SameRow Cloud at {Uri} during claim", claimUri);
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    status = "unavailable",
                    error = "Could not reach SameRow Cloud. Retrying shortly..."
                });
            }

            using var responseScope = response;
            if (response.StatusCode == HttpStatusCode.Accepted)
            {
                return StatusCode(StatusCodes.Status202Accepted, new
                {
                    status = "pending",
                    message = "Waiting for you to sign in and click Approve on SameRow Web."
                });
            }

            if (response.StatusCode == HttpStatusCode.Gone)
            {
                _currentPending = null;
                return StatusCode(StatusCodes.Status410Gone, new
                {
                    status = "expired",
                    error = "Pairing approval expired or was rejected. Please start again."
                });
            }

            if (!response.IsSuccessStatusCode)
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    status = "unavailable",
                    error = "Pairing claim failed. Try again shortly."
                });
            }

            var claimResult = await response.Content.ReadFromJsonAsync<ClaimApprovalResponse>();
            if (claimResult == null || !System.Text.RegularExpressions.Regex.IsMatch(claimResult.Token, "^[a-f0-9]{32}\\.[a-f0-9]{64}$") || !IsHttpsOrigin(claimResult.Gateway))
            {
                return StatusCode(StatusCodes.Status503ServiceUnavailable, new
                {
                    status = "unavailable",
                    error = "Malformed credentials received from SameRow Cloud."
                });
            }

            var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
            config.ConnectorToken = claimResult.Token;
            config.GatewayUrl = claimResult.Gateway;
            config.ConnectorId = claimResult.Token.Split('.')[0];
            config.SameRowWebUrl = pending.WebUrl;
            config.SameRowControlUrl = pending.ControlUrl;
            config.PairedAt = DateTime.UtcNow;

            Plugin.Instance?.SaveConnectorConfiguration();
            _currentPending = null;

            // Trigger background connector worker loops
            await _connectorService.RestartAsync();

            return Ok(new
            {
                status = "paired",
                id = pending.Id,
                gateway = claimResult.Gateway
            });
        }
        finally
        {
            PairingLock.Release();
        }
    }

    /// <summary>
    /// Disconnects this server from SameRow and revokes credentials.
    /// </summary>
    [HttpPost("Disconnect")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> Disconnect()
    {
        await PairingLock.WaitAsync();
        try
        {
            _currentPending = null;
            var config = Plugin.Instance?.Configuration;
            if (config == null || !config.IsPaired) return Ok(new { status = "already_disconnected" });
            if (!string.IsNullOrEmpty(config.PendingProtectedConnectorToken))
                return Conflict(new { error = "Retry credential rotation before disconnecting." });

            // Keep the saved token on failure so the administrator can retry revocation.
            using var request = new HttpRequestMessage(HttpMethod.Delete,
                $"{config.GatewayUrl.TrimEnd('/')}/api/jellyfin-relay/pair/{config.ConnectorId}");
            request.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", config.ConnectorToken);
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                using var client = _httpClientFactory.CreateClient("SameRowCloud");
                using var response = await client.SendAsync(request, timeout.Token);
                if (!response.IsSuccessStatusCode && response.StatusCode != HttpStatusCode.Unauthorized &&
                    response.StatusCode != HttpStatusCode.NotFound)
                    return StatusCode(503, new { error = "Could not revoke this connection. Try again shortly." });
            }
            catch (HttpRequestException)
            {
                return StatusCode(503, new { error = "Could not reach SameRow to disconnect. Try again shortly." });
            }
            catch (OperationCanceledException)
            {
                return StatusCode(503, new { error = "Disconnect timed out. Try again shortly." });
            }
            config.ConnectorToken = string.Empty;
            config.ConnectorId = string.Empty;
            config.GatewayUrl = string.Empty;
            config.PairedAt = null;
            Plugin.Instance?.SaveConnectorConfiguration();
            await _connectorService.RestartAsync();
            return Ok(new { status = "disconnected" });
        }
        finally { PairingLock.Release(); }
    }

    [HttpPost("Rotate")]
    public async Task<IActionResult> RotateCredential()
    {
        await PairingLock.WaitAsync();
        try
        {
            var plugin = Plugin.Instance;
            if (plugin == null || !plugin.Configuration.IsPaired) return Conflict(new { error = "Connect this server first." });
            var config = plugin.Configuration;
            if (string.IsNullOrEmpty(config.PendingProtectedConnectorToken))
            {
                plugin.PendingCredential = config.ConnectorId + "." + Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
                plugin.SaveConnectorConfiguration();
            }
            var next = plugin.PendingCredential;
            using var message = new HttpRequestMessage(HttpMethod.Post, config.GatewayUrl.TrimEnd('/') + "/api/jellyfin-relay/rotate");
            message.Headers.Authorization = new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer", config.ConnectorToken);
            message.Content = JsonContent.Create(new { token = next });
            try
            {
                using var timeout = new CancellationTokenSource(TimeSpan.FromSeconds(20));
                using var client = _httpClientFactory.CreateClient("SameRowCloud");
                using var response = await client.SendAsync(message, timeout.Token);
                if (!response.IsSuccessStatusCode) return StatusCode(503, new { error = "Credential rotation failed. Retry to finish it." });
            }
            catch (Exception ex) when (ex is HttpRequestException or OperationCanceledException)
            {
                return StatusCode(503, new { error = "Could not finish credential rotation. Retry when the connection returns." });
            }
            config.ConnectorToken = next;
            plugin.PendingCredential = "";
            plugin.SaveConnectorConfiguration();
            await _connectorService.RestartAsync();
            return Ok(new { status = "rotated" });
        }
        finally { PairingLock.Release(); }
    }

    [HttpPost("Pair/Cancel")]
    public async Task<IActionResult> CancelPairing()
    {
        await PairingLock.WaitAsync();
        try { _currentPending = null; return Ok(new { status = "cancelled" }); }
        finally { PairingLock.Release(); }
    }

    /// <summary>
    /// Updates plugin settings such as custom server name or permitted library IDs.
    /// </summary>
    [HttpPost("Settings")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public async Task<IActionResult> UpdateSettings([FromBody] UpdateSettingsRequest request)
    {
        var config = Plugin.Instance?.Configuration;
        if (config == null) return BadRequest();

        if (request.AllowedLibraryIds?.Length > 0)
            return BadRequest(new { error = "Use Jellyfin user permissions to limit library access." });
        if (request.WorkerCount.HasValue && (request.WorkerCount < 1 || request.WorkerCount > 16))
            return BadRequest(new { error = "Choose between 1 and 16 relay workers." });
        if (!string.IsNullOrWhiteSpace(request.SameRowWebUrl) && !IsHttpsOrigin(request.SameRowWebUrl.TrimEnd('/')))
            return BadRequest(new { error = "Enter a valid HTTPS web origin." });
        if (!string.IsNullOrWhiteSpace(request.SameRowControlUrl) && !IsHttpsOrigin(request.SameRowControlUrl.TrimEnd('/')))
            return BadRequest(new { error = "Enter a valid HTTPS control origin." });

        if (request.ServerFriendlyName != null)
            config.ServerFriendlyName = request.ServerFriendlyName.Trim();



        if (request.WorkerCount.HasValue && request.WorkerCount.Value >= 1 && request.WorkerCount.Value <= 16)
            config.WorkerCount = request.WorkerCount.Value;

        if (!string.IsNullOrWhiteSpace(request.SameRowWebUrl))
            config.SameRowWebUrl = request.SameRowWebUrl.TrimEnd('/');

        if (!string.IsNullOrWhiteSpace(request.SameRowControlUrl))
            config.SameRowControlUrl = request.SameRowControlUrl.TrimEnd('/');
        if (request.AutoStart.HasValue) config.AutoStart = request.AutoStart.Value;
        Plugin.Instance?.SaveConnectorConfiguration();

        if (config.IsPaired)
        {
            await _connectorService.RestartAsync();
        }

        return Ok(new { status = "updated" });
    }
    public static bool IsHttpsOrigin(string value) =>
        Uri.TryCreate(value, UriKind.Absolute, out var uri) && uri.Scheme == Uri.UriSchemeHttps &&
        string.IsNullOrEmpty(uri.UserInfo) && string.IsNullOrEmpty(uri.Query) &&
        string.IsNullOrEmpty(uri.Fragment) && uri.AbsolutePath == "/" &&
        value.TrimEnd('/') == uri.GetLeftPart(UriPartial.Authority);
}

public class StartPairingRequest
{
    public string? WebUrl { get; set; }
    public string? ControlUrl { get; set; }
}

public class ClaimPairingRequest
{
    public string? Id { get; set; }
}

public class UpdateSettingsRequest
{
    public string? SameRowControlUrl { get; set; }
    public bool? AutoStart { get; set; }
    public string? ServerFriendlyName { get; set; }
    public string[]? AllowedLibraryIds { get; set; }
    public int? WorkerCount { get; set; }
    public string? SameRowWebUrl { get; set; }
}

public class StartApprovalResponse
{
    [JsonPropertyName("id")]
    public string Id { get; set; } = string.Empty;
}

public class ClaimApprovalResponse
{
    [JsonPropertyName("token")]
    public string Token { get; set; } = string.Empty;

    [JsonPropertyName("gateway")]
    public string Gateway { get; set; } = string.Empty;
}

public class PendingPairingAttempt
{
    public string Id { get; set; } = string.Empty;
    public string Secret { get; set; } = string.Empty;
    public string ControlUrl { get; set; } = string.Empty;
    public string WebUrl { get; set; } = string.Empty;
    public string ApprovalUrl { get; set; } = string.Empty;
    public DateTime ExpiresAt { get; set; }

    public bool IsExpired => DateTime.UtcNow >= ExpiresAt;
}
