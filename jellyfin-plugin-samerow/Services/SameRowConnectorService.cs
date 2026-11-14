// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Controller;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using SameRow.Plugin.Configuration;

namespace SameRow.Plugin.Services;

public enum ConnectorConnectionState
{
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
    AuthenticationFailed,
    Stopped
}

/// <summary>
/// Background service maintaining authenticated outbound long-polling connections to SameRow Cloud,
/// proxying media and API calls to the local Jellyfin server instance with zero transcoding overhead
/// and binary byte-for-byte stream fidelity.
/// </summary>
public class SameRowConnectorService : IHostedService, IDisposable
{
    private const string RelayPath = "/api/jellyfin-relay";
    private static readonly string[] AllowedResponseHeaders = new[]
    {
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "last-modified",
        "etag"
    };

    private readonly IServerApplicationHost _applicationHost;
    private readonly IHttpClientFactory _httpClientFactory;
    private readonly ILogger<SameRowConnectorService> _logger;
    private CancellationTokenSource _cts = new();
    private bool _stopped;
    private int _disposed;
    private int _reportedConnected;

    private readonly List<Task> _workers = new();
    private readonly SemaphoreSlim _stateLock = new(1, 1);
    private int _activeJobCount;
    private long _totalJobsHandled;
    private long _totalBytesRelayed;

    public SameRowConnectorService(
        IServerApplicationHost applicationHost,
        IHttpClientFactory httpClientFactory,
        ILogger<SameRowConnectorService> logger)
    {
        _applicationHost = applicationHost;
        _httpClientFactory = httpClientFactory;
        _logger = logger;
    }

    public ConnectorConnectionState State { get; private set; } = ConnectorConnectionState.Disconnected;
    public string? LastError { get; private set; }
    public DateTime? LastConnectedAt { get; private set; }
    public DateTime? LastActivityAt { get; private set; }
    public int ActiveJobs => Volatile.Read(ref _activeJobCount);
    public long TotalJobs => Interlocked.Read(ref _totalJobsHandled);
    public long TotalBytes => Interlocked.Read(ref _totalBytesRelayed);

    public async Task StartAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        await _stateLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (_stopped || _workers.Count > 0) return;
            var config = Plugin.Instance?.Configuration ?? new PluginConfiguration();
            if (config.AutoStart && config.IsPaired) StartWorkers(config);
            else State = ConnectorConnectionState.Disconnected;
        }
        finally { _stateLock.Release(); }
    }

    public async Task StopAsync(CancellationToken cancellationToken)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        _logger.LogInformation("Stopping SameRow Connector service...");
        await _stateLock.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            _stopped = true;
            State = ConnectorConnectionState.Stopped;
            _cts.Cancel();

            try
            {
                await Task.WhenAll(_workers).ConfigureAwait(false);
            }
            catch (Exception)
            {
                // Expected on cancellation
            }

            _workers.Clear();
        }
        finally { _stateLock.Release(); }
    }

    /// <summary>
    /// Restarts workers after configuration change or re-pairing.
    /// </summary>
    public async Task RestartAsync()
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        await _stateLock.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_stopped) return;
            _cts.Cancel();
            try { await Task.WhenAll(_workers).ConfigureAwait(false); } catch { }
            _workers.Clear();
            _cts.Dispose();
            _cts = new CancellationTokenSource();
            LastError = null;
            Interlocked.Exchange(ref _reportedConnected, 0);

            var config = Plugin.Instance?.Configuration;
            if (config != null && config.IsPaired)
            {
                StartWorkers(config);
            }
            else
            {
                State = ConnectorConnectionState.Disconnected;
            }
        }
        finally
        {
            _stateLock.Release();
        }
    }

    private void StartWorkers(PluginConfiguration config)
    {
        int count = Math.Max(1, Math.Min(8, config.WorkerCount));
        _logger.LogInformation("Spawning {Count} SameRow relay worker loops to {Gateway}", count, config.GatewayUrl);
        State = ConnectorConnectionState.Connecting;

        var generationToken = _cts.Token;
        if (!string.Equals(Environment.GetEnvironmentVariable("SAMEROW_DIRECT_ENABLED"), "false", StringComparison.OrdinalIgnoreCase))
        {
            _workers.Add(Task.Run(() => RunDirectSenderAsync(config, generationToken)));
        }
        for (int i = 0; i < count; i++)
        {
            int workerIndex = i;
            _workers.Add(Task.Run(() => WorkerLoopAsync(workerIndex, generationToken)));
        }
    }

    private async Task RunDirectSenderAsync(PluginConfiguration config, CancellationToken stoppingToken)
    {
        string? platform = OperatingSystem.IsLinux() ? "linux" : OperatingSystem.IsMacOS() ? "darwin" :
            OperatingSystem.IsWindows() ? "windows" : null;
        string? arch = RuntimeInformation.ProcessArchitecture switch { Architecture.X64 => "amd64", Architecture.Arm64 => "arm64", _ => null };
        if (platform == null || arch == null) return;
        var name = $"samerow-sender-{platform}-{arch}" + (OperatingSystem.IsWindows() ? ".exe" : "");
        var path = Path.Combine(Path.GetDirectoryName(typeof(SameRowConnectorService).Assembly.Location)!, name);
        if (!File.Exists(path))
        {
            _logger.LogWarning("SameRow direct sender is missing for this Jellyfin platform.");
            return;
        }

        // Jellyfin's plugin installer may extract ZIP entries without execute bits.
        if (!OperatingSystem.IsWindows())
        {
            try { File.SetUnixFileMode(path, File.GetUnixFileMode(path) | UnixFileMode.UserExecute); }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
            {
                _logger.LogWarning("SameRow could not enable execution of the direct sender.");
            }
        }
        while (!stoppingToken.IsCancellationRequested)
        {
            using var sender = new Process { StartInfo = new ProcessStartInfo(path) {
                UseShellExecute = false, RedirectStandardInput = true, CreateNoWindow = true
            } };
            try
            {
                if (!sender.Start()) throw new InvalidOperationException();
                var message = JsonSerializer.Serialize(new {
                    Gateway = config.GatewayUrl, Token = config.ConnectorToken, LocalURL = LocalApiUrl(),
                    STUN = Environment.GetEnvironmentVariable("SAMEROW_DIRECT_STUN") ?? ""
                });
                await sender.StandardInput.WriteLineAsync(message.AsMemory(), stoppingToken).ConfigureAwait(false);
                await sender.StandardInput.FlushAsync(stoppingToken).ConfigureAwait(false);
                await sender.WaitForExitAsync(stoppingToken).ConfigureAwait(false);
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested) { }
            catch (Exception ex) { _logger.LogWarning("SameRow direct sender unavailable ({ErrorType}).", ex.GetType().Name); }
            finally
            {
                try
                {
                    if (!sender.HasExited)
                    {
                        sender.Kill();
                        await sender.WaitForExitAsync().ConfigureAwait(false);
                    }
                }
                catch (InvalidOperationException) { }
            }
            await Task.Delay(TimeSpan.FromSeconds(5), stoppingToken).ConfigureAwait(false);
        }
    }

    private string LocalApiUrl()
    {
        int port = _applicationHost.HttpPort;
        if (port <= 0) port = 8096;
        var baseUrl = _applicationHost.GetLocalApiUrl("127.0.0.1", "http", port);
        return string.IsNullOrEmpty(baseUrl) ? $"http://127.0.0.1:{port}" : baseUrl;
    }

    private async Task WorkerLoopAsync(int workerIndex, CancellationToken stoppingToken)
    {
        int failureCount = 0;
        var rnd = new Random();

        while (!stoppingToken.IsCancellationRequested)
        {
            var config = Plugin.Instance?.Configuration;
            if (config == null || !config.IsPaired)
            {
                State = ConnectorConnectionState.Disconnected;
                await Task.Delay(3000, stoppingToken).ConfigureAwait(false);
                continue;
            }

            try
            {
                var job = await PollForJobAsync(config, stoppingToken).ConfigureAwait(false);
                if (job == null)
                {
                    // 204 No Content - loop timeout with no job, poll again immediately
                    ReportConnected();
                    await Task.Delay(50, stoppingToken).ConfigureAwait(false);
                    failureCount = 0;
                    continue;
                }

                ReportConnected();
                LastActivityAt = DateTime.UtcNow;
                failureCount = 0;

                Interlocked.Increment(ref _activeJobCount);
                try
                {
                    await ProcessJobAsync(job, config, stoppingToken).ConfigureAwait(false);
                    Interlocked.Increment(ref _totalJobsHandled);
                }
                finally
                {
                    Interlocked.Decrement(ref _activeJobCount);
                }
            }
            catch (OperationCanceledException) when (stoppingToken.IsCancellationRequested)
            {
                break;
            }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.Unauthorized)
            {
                State = ConnectorConnectionState.AuthenticationFailed;
                LastError = "Authentication failed: Connector token was revoked or expired. Please re-pair from the Jellyfin dashboard.";
                _logger.LogWarning("SameRow Cloud rejected connector token (401). Worker {Index} backing off.", workerIndex);
                break; // A new pairing explicitly restarts workers; a revoked token cannot recover by polling.
            }
            catch (HttpRequestException ex) when (ex.StatusCode == HttpStatusCode.TooManyRequests)
            {
                _logger.LogWarning("SameRow Cloud returned 429 Too Many Requests. Worker {Index} backing off.", workerIndex);
                failureCount++;
                State = ConnectorConnectionState.Reconnecting;
                LastError = "The gateway is busy. Retrying automatically.";
                await Task.Delay(Math.Min(30000, 5000 * Math.Min(failureCount, 6)) + rnd.Next(1000, 4000), stoppingToken).ConfigureAwait(false);
            }
            catch (Exception ex)
            {
                failureCount++;
                State = ConnectorConnectionState.Reconnecting;
                LastError = "The relay connection was interrupted. Reconnecting automatically.";
                int delayMs = Math.Min(30000, (int)Math.Pow(2, Math.Min(failureCount, 5)) * 1000) + rnd.Next(500, 2000);
                _logger.LogDebug(ex, "Worker {Index} encountered error. Backing off for {Delay}ms", workerIndex, delayMs);
                await Task.Delay(delayMs, stoppingToken).ConfigureAwait(false);
            }
        }
    }

    private void ReportConnected()
    {
        State = ConnectorConnectionState.Connected;
        LastError = null;
        if (Interlocked.Exchange(ref _reportedConnected, 1) == 0)
        {
            LastConnectedAt = DateTime.UtcNow;
            _logger.LogInformation("SameRow relay connection established: gateway accepted an authenticated poll.");
        }
    }

    private async Task<RelayJob?> PollForJobAsync(PluginConfiguration config, CancellationToken cancellationToken)
    {
        using var cloudClient = _httpClientFactory.CreateClient("SameRowCloud");
        var gateway = new Uri(config.GatewayUrl.TrimEnd('/') + $"{RelayPath}/poll");

        using var request = new HttpRequestMessage(HttpMethod.Get, gateway);
        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ConnectorToken);

        // 25-second poll timeout matches SameRow relay gateway expectation
        using var linkedCts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        linkedCts.CancelAfter(TimeSpan.FromSeconds(28));

        using var response = await cloudClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead, linkedCts.Token)
            .ConfigureAwait(false);

        if (response.StatusCode == HttpStatusCode.NoContent)
        {
            return null;
        }

        if (response.StatusCode == HttpStatusCode.Unauthorized)
        {
            throw new HttpRequestException("Unauthorized", null, HttpStatusCode.Unauthorized);
        }

        if (response.StatusCode == HttpStatusCode.TooManyRequests)
        {
            throw new HttpRequestException("Rate limited", null, HttpStatusCode.TooManyRequests);
        }

        response.EnsureSuccessStatusCode();

        await response.Content.LoadIntoBufferAsync(128 * 1024, linkedCts.Token).ConfigureAwait(false);
        var json = await response.Content.ReadAsStringAsync(linkedCts.Token).ConfigureAwait(false);
        return JsonSerializer.Deserialize<RelayJob>(json, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });
    }

    private async Task ProcessJobAsync(RelayJob job, PluginConfiguration config, CancellationToken cancellationToken)
    {
        if (string.IsNullOrEmpty(job.Job) || !System.Text.RegularExpressions.Regex.IsMatch(job.Job, "^[a-f0-9]{32}$"))
        {
            _logger.LogWarning("Discarding malformed relay job id: {JobId}", job.Job);
            return;
        }

        var method = (job.Method ?? "GET").ToUpperInvariant();
        if (method != "GET" && method != "HEAD" && method != "POST" && method != "DELETE")
        {
            _logger.LogWarning("Discarding disallowed relay job HTTP method: {Method}", method);
            return;
        }

        // Validate local target path to prevent SSRF or directory traversal
        if ((job.ProtocolVersion != null && job.ProtocolVersion != 1) || !IsAllowedRequest(method, job.Resource))
        {
            _logger.LogWarning("Rejecting invalid Jellyfin resource path.");
            await UploadErrorResponseAsync(config, job.Job, HttpStatusCode.BadRequest, cancellationToken).ConfigureAwait(false);
            return;
        }

        // Target local Jellyfin instance directly over loopback
        var localUri = new Uri(LocalApiUrl().TrimEnd('/') + job.Resource);

        // Build the local Jellyfin request
        using var localRequest = new HttpRequestMessage(new HttpMethod(method), localUri);

        // Set Jellyfin authorization header
        string deviceId = string.IsNullOrEmpty(job.DeviceId) ? "samerow" : job.DeviceId;
        if (!IsSafeHeaderValue(deviceId) || (job.ApiToken != null && !IsSafeHeaderValue(job.ApiToken)))
        {
            await UploadErrorResponseAsync(config, job.Job, HttpStatusCode.BadRequest, cancellationToken).ConfigureAwait(false);
            return;
        }
        string authValue = $"MediaBrowser Client=\"SameRow\", Device=\"SameRow Web\", DeviceId=\"{deviceId}\", Version=\"1.0.0\"" +
                           (!string.IsNullOrEmpty(job.ApiToken) ? $", Token=\"{job.ApiToken}\"" : string.Empty);
        localRequest.Headers.TryAddWithoutValidation("Authorization", authValue);
        localRequest.Headers.TryAddWithoutValidation("Accept-Encoding", "identity");

        // Forward allowed client headers (e.g. Range requests for byte-for-byte playback seeking)
        if (job.Headers != null)
        {
            foreach (var kvp in job.Headers)
            {
                var lowerKey = kvp.Key.ToLowerInvariant();
                if (lowerKey == "range" || lowerKey == "if-range" || lowerKey == "accept")
                {
                    localRequest.Headers.TryAddWithoutValidation(kvp.Key, kvp.Value);
                }
            }
        }

        if (!string.IsNullOrEmpty(job.Body) && method == "POST")
        {
            string contentType = job.Headers != null && job.Headers.TryGetValue("content-type", out var ct) ? ct : "application/json";
            localRequest.Content = new StringContent(job.Body, Encoding.UTF8, contentType);
        }

        using var loopbackClient = _httpClientFactory.CreateClient("SameRowLoopback");
        HttpResponseMessage? localResponse = null;

        try
        {
            // Use ResponseHeadersRead so video streams are never buffered into memory
            using var headerTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            headerTimeout.CancelAfter(TimeSpan.FromSeconds(20));
            localResponse = await loopbackClient.SendAsync(localRequest, HttpCompletionOption.ResponseHeadersRead, headerTimeout.Token)
                .ConfigureAwait(false);
            headerTimeout.CancelAfter(Timeout.InfiniteTimeSpan);
        }
        catch (Exception ex)
        {
            _logger.LogWarning("Failed to query local Jellyfin endpoint ({ErrorType}).", ex.GetType().Name);
            await UploadErrorResponseAsync(config, job.Job, HttpStatusCode.BadGateway, cancellationToken).ConfigureAwait(false);
            return;
        }

        try
        {
            await UploadRelayResponseAsync(config, job.Job, method, localResponse, cancellationToken).ConfigureAwait(false);
        }
        finally
        {
            localResponse?.Dispose();
        }
    }

    private async Task UploadRelayResponseAsync(
        PluginConfiguration config,
        string jobId,
        string requestMethod,
        HttpResponseMessage upstreamResponse,
        CancellationToken cancellationToken)
    {
        using var cloudClient = _httpClientFactory.CreateClient("SameRowCloud");
        var uploadUri = new Uri(config.GatewayUrl.TrimEnd('/') + $"{RelayPath}/response/{jobId}");

        using var uploadRequest = new HttpRequestMessage(HttpMethod.Post, uploadUri);
        uploadRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ConnectorToken);

        int statusCode = (int)upstreamResponse.StatusCode;
        uploadRequest.Headers.TryAddWithoutValidation("X-Relay-Status", statusCode.ToString());

        // Extract and forward critical streaming and media headers
        var relayHeaders = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);

        void ExtractHeader(string name, HttpHeaders headers)
        {
            if (headers.TryGetValues(name, out var values))
            {
                relayHeaders[name] = string.Join(", ", values);
            }
        }

        foreach (var field in AllowedResponseHeaders)
        {
            ExtractHeader(field, upstreamResponse.Headers);
            if (upstreamResponse.Content != null)
            {
                ExtractHeader(field, upstreamResponse.Content.Headers);
            }
        }

        string headersJson = JsonSerializer.Serialize(relayHeaders);
        uploadRequest.Headers.TryAddWithoutValidation("X-Relay-Headers", headersJson);

        // HEAD requests or 204/205 responses carry no body
        if (requestMethod == "HEAD" || statusCode == 204 || statusCode == 205 || upstreamResponse.Content == null)
        {
            using var uploadResponse = await cloudClient.SendAsync(uploadRequest, HttpCompletionOption.ResponseContentRead, cancellationToken)
                .ConfigureAwait(false);
            uploadResponse.EnsureSuccessStatusCode();
            return;
        }

        // For streaming video, chunked data, range requests: stream binary data directly
        // Stream.CopyToAsync inside StreamContent writes chunks directly without memory buffering
        using var upstreamStream = await upstreamResponse.Content.ReadAsStreamAsync(cancellationToken).ConfigureAwait(false);
        var trackingStream = new ProgressTrackingStream(upstreamStream, bytes => Interlocked.Add(ref _totalBytesRelayed, bytes));

        uploadRequest.Content = new StreamContent(trackingStream, bufferSize: 64 * 1024);
        // This is an opaque relay upload. The original type belongs only in
        // X-Relay-Headers, otherwise the gateway's JSON parser consumes it.
        uploadRequest.Content.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");

        using var streamUploadResponse = await cloudClient.SendAsync(uploadRequest, HttpCompletionOption.ResponseContentRead, cancellationToken)
            .ConfigureAwait(false);
        streamUploadResponse.EnsureSuccessStatusCode();
    }

    private async Task UploadErrorResponseAsync(
        PluginConfiguration config,
        string jobId,
        HttpStatusCode status,
        CancellationToken cancellationToken)
    {
        try
        {
            using var cloudClient = _httpClientFactory.CreateClient("SameRowCloud");
            var uploadUri = new Uri(config.GatewayUrl.TrimEnd('/') + $"{RelayPath}/response/{jobId}");

            using var uploadRequest = new HttpRequestMessage(HttpMethod.Post, uploadUri);
            uploadRequest.Headers.Authorization = new AuthenticationHeaderValue("Bearer", config.ConnectorToken);
            uploadRequest.Headers.TryAddWithoutValidation("X-Relay-Status", ((int)status).ToString());
            uploadRequest.Headers.TryAddWithoutValidation("X-Relay-Headers", "{}");

            using var response = await cloudClient.SendAsync(uploadRequest, HttpCompletionOption.ResponseContentRead, cancellationToken)
                .ConfigureAwait(false);
        }
        catch (Exception ex)
        {
            _logger.LogDebug(ex, "Failed to upload error status {Status} for job {Job}", status, jobId);
        }
    }

    public static bool IsValidResource(string? resource)
    {
        if (string.IsNullOrEmpty(resource) || !resource.StartsWith('/') || resource.StartsWith("//") ||
            resource.Contains('\\') || resource.Contains('#') || resource.Any(char.IsControl)) return false;
        var path = resource.Split('?')[0];
        // Decode before checking because the HTTP server normalizes escaped path segments.
        for (var pass = 0; pass < 3; pass++)
        {
            path = Uri.UnescapeDataString(path);
            if (path.Contains('\\') || path.StartsWith("//") || path.Split('/').Any(segment => segment is "." or "..")) return false;
        }
        return !path.Contains('%');
    }

    public static bool IsAllowedRequest(string method, string? resource)
    {
        if (!IsValidResource(resource)) return false;
        var path = Uri.UnescapeDataString(resource!.Split('?')[0]);
        var read = method is "GET" or "HEAD";
        if (read && System.Text.RegularExpressions.Regex.IsMatch(path,
            @"^/(web/[^?#]+|System/Info/Public|Users/(Me|[a-zA-Z0-9_-]+)|Users/[a-zA-Z0-9_-]+/Items(/[a-zA-Z0-9_-]+)?|Items(/[a-zA-Z0-9_-]+(/(Images/[^?#]+|PlaybackInfo))?)?|Videos/[a-zA-Z0-9_-]+/[^?#]+|Localization/(Cultures|Countries|Options|ParentalRatings)|Playback/BitrateTest|QuickConnect/Connect)$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase))
            return true;
        if (method == "POST") return System.Text.RegularExpressions.Regex.IsMatch(path,
            @"^/(Users/(AuthenticateByName|AuthenticateWithQuickConnect)|QuickConnect/Initiate|Items/[a-zA-Z0-9_-]+/PlaybackInfo|Sessions/(Logout|Capabilities(/Full)?|Playing(/(Progress|Stopped|Ping))?))$",
            System.Text.RegularExpressions.RegexOptions.IgnoreCase);
        return method == "DELETE" && path.Equals("/Videos/ActiveEncodings", StringComparison.OrdinalIgnoreCase);
    }

    private static bool IsSafeHeaderValue(string value) =>
        value.Length <= 4096 && !value.Any(character => character < 32 || character == 127 || character is '"' or '\\');

    public void Dispose()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;
        _stopped = true;
        _cts.Cancel();
        _cts.Dispose();
        _stateLock.Dispose();
    }
}

public class RelayJob
{
    [JsonPropertyName("protocolVersion")]
    public int? ProtocolVersion { get; set; }
    [JsonPropertyName("job")]
    public string Job { get; set; } = string.Empty;

    [JsonPropertyName("method")]
    public string Method { get; set; } = "GET";

    [JsonPropertyName("resource")]
    public string Resource { get; set; } = string.Empty;

    [JsonPropertyName("headers")]
    public Dictionary<string, string>? Headers { get; set; }

    [JsonPropertyName("body")]
    public string? Body { get; set; }

    [JsonPropertyName("apiToken")]
    public string? ApiToken { get; set; }

    [JsonPropertyName("deviceId")]
    public string? DeviceId { get; set; }
}

/// <summary>
/// Stream wrapper that tracks byte throughput with zero buffer duplication.
/// </summary>
public class ProgressTrackingStream : Stream
{
    private readonly Stream _inner;
    private readonly Action<long> _onRead;

    public ProgressTrackingStream(Stream inner, Action<long> onRead)
    {
        _inner = inner;
        _onRead = onRead;
    }

    public override bool CanRead => _inner.CanRead;
    public override bool CanSeek => _inner.CanSeek;
    public override bool CanWrite => _inner.CanWrite;
    public override long Length => _inner.Length;
    public override long Position
    {
        get => _inner.Position;
        set => _inner.Position = value;
    }

    public override void Flush() => _inner.Flush();
    public override Task FlushAsync(CancellationToken cancellationToken) => _inner.FlushAsync(cancellationToken);

    public override int Read(byte[] buffer, int offset, int count)
    {
        int read = _inner.Read(buffer, offset, count);
        if (read > 0) _onRead(read);
        return read;
    }

    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default)
    {
        int read = await _inner.ReadAsync(buffer, cancellationToken).ConfigureAwait(false);
        if (read > 0) _onRead(read);
        return read;
    }

    public override async Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken)
    {
        int read = await _inner.ReadAsync(buffer, offset, count, cancellationToken).ConfigureAwait(false);
        if (read > 0) _onRead(read);
        return read;
    }

    public override long Seek(long offset, SeekOrigin origin) => _inner.Seek(offset, origin);
    public override void SetLength(long value) => _inner.SetLength(value);
    public override void Write(byte[] buffer, int offset, int count) => _inner.Write(buffer, offset, count);
    public override Task WriteAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) =>
        _inner.WriteAsync(buffer, offset, count, cancellationToken);

    protected override void Dispose(bool disposing)
    {
        if (disposing) _inner.Dispose();
        base.Dispose(disposing);
    }
}
