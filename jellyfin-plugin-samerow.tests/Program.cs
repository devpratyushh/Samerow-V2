// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Net.Http.Json;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Controller;
using MediaBrowser.Model.Serialization;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Extensions.Logging.Abstractions;
using Microsoft.Extensions.Logging;
using SameRow.Plugin;
using SameRow.Plugin.Configuration;
using SameRow.Plugin.Controllers;
using SameRow.Plugin.Services;

namespace SameRow.Plugin.Tests;

public static class Program
{
    private static int _passCount = 0;
    private static int _failCount = 0;

    public static async Task<int> Main(string[] args)
    {
        AppDomain.CurrentDomain.AssemblyResolve += (sender, resolveArgs) =>
        {
            var name = new AssemblyName(resolveArgs.Name).Name + ".dll";
            var absPath = Path.Combine(Environment.GetEnvironmentVariable("JELLYFIN_SERVER_PATH") ?? Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../jellyfin-sandbox/jellyfin")), name);
            if (File.Exists(absPath)) return Assembly.LoadFrom(absPath);
            return null;
        };

        if (args.Contains("--relay")) return await RunRelayAsync();

        Console.WriteLine("=== Running SameRow Connect Plugin Test Suite ===");

        await RunTestAsync("Configuration: Default state and IsPaired logic", TestConfigurationDefaults);
        await RunTestAsync("Credential protection: persistence, permissions, tamper rejection", TestCredentials);
        await RunTestAsync("Stream Fidelity: Exact byte order and byte count tracking", TestProgressTrackingStreamFidelity);
        await RunTestAsync("Path Security: SSRF, traversal and malformed paths rejected", TestPathSecurity);
        await RunTestAsync("Relay Protocol: Range request with 206 Partial Content and binary body", () => TestRelayRangeRequestStreaming(false));
        await RunTestAsync("Relay Protocol: JSON is carried as opaque bytes", () => TestRelayRangeRequestStreaming(true));
        await RunTestAsync("Relay Lifecycle: 401 Unauthorized enters AuthFailed state", TestRelayAuthFailure);
        await RunTestAsync("Controller: Pairing flow (Start, Claim, Status, Disconnect)", TestControllerPairingWorkflow);
        await RunTestAsync("Controller: Settings update and friendly name persistence", TestControllerSettings);
        await RunTestAsync("Plugin Metadata: GUID, Name, and WebPage registration", TestPluginMetadata);

        Console.WriteLine($"\nTest Results: {_passCount} passed, {_failCount} failed.");
        return _failCount > 0 ? 1 : 0;
    }

    private static async Task<int> RunRelayAsync()
    {
            var uri = new Uri(Environment.GetEnvironmentVariable("SAMEROW_TEST_JELLYFIN") ?? "http://127.0.0.1:8096");
            var gateway = Environment.GetEnvironmentVariable("SAMEROW_TEST_GATEWAY") ?? throw new InvalidOperationException("Missing gateway");
            var token = Environment.GetEnvironmentVariable("SAMEROW_TEST_CONNECTOR") ?? throw new InvalidOperationException("Missing connector");
            if (!new Uri(gateway).IsLoopback || !uri.IsLoopback) throw new InvalidOperationException("Test relay is restricted to loopback servers");
            InitMockPlugin(gateway, token);
            var host = DuckProxy.Create<IServerApplicationHost>(proxy =>
            {
                proxy.Returns["get_HttpPort"] = uri.Port;
                proxy.Returns["get_CoreStartupHasCompleted"] = true;
            });
            using var loggerFactory = LoggerFactory.Create(builder => builder.AddConsole().SetMinimumLevel(LogLevel.Debug));
            using var service = new SameRowConnectorService(host, new RealHttpClientFactory(), loggerFactory.CreateLogger<SameRowConnectorService>());
            using var cancellation = new CancellationTokenSource();
            Console.CancelKeyPress += (_, eventArgs) => { eventArgs.Cancel = true; cancellation.Cancel(); };
            await service.StartAsync(CancellationToken.None);
            Console.WriteLine("Test relay started");
            try { await Task.Delay(Timeout.Infinite, cancellation.Token); }
            catch (OperationCanceledException) { }
            await service.StopAsync(CancellationToken.None);
            return 0;
    }

    private static async Task RunTestAsync(string name, Func<Task> testFunc)
    {
        try
        {
            await testFunc();
            Console.WriteLine($"  ✔ {name}");
            _passCount++;
        }
        catch (Exception ex)
        {
            Console.WriteLine($"  ✖ {name}\n    Error: {ex.Message}\n    StackTrace:\n{ex.StackTrace}");
            if (ex.InnerException != null)
            {
                Console.WriteLine($"    Inner: {ex.InnerException.Message}");
            }
            _failCount++;
        }
    }

    private static void Assert(bool condition, string message)
    {
        if (!condition) throw new InvalidOperationException($"Assertion failed: {message}");
    }

    private static void AssertEqual<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
            throw new InvalidOperationException($"Assertion failed for '{message}'. Expected: {expected}, Actual: {actual}");
    }

    private static Task TestCredentials()
    {
        var directory = Path.Combine(Path.GetTempPath(), "samerow-credential-test-" + Guid.NewGuid());
        try
        {
            var vault = new CredentialVault(directory);
            var token = "secret-connector-credential";
            var encrypted = vault.Protect(token);
            Assert(!encrypted.Contains(token), "Saved value does not contain the credential");
            AssertEqual(token, new CredentialVault(directory).Unprotect(encrypted), "Key survives service restart");
            var bytes = Convert.FromBase64String(encrypted);
            bytes[^1] ^= 1;
            bool rejected = false;
            try { vault.Unprotect(Convert.ToBase64String(bytes)); }
            catch (CryptographicException) { rejected = true; }
            Assert(rejected, "Modified ciphertext is rejected");
            if (!OperatingSystem.IsWindows())
                AssertEqual(UnixFileMode.UserRead | UnixFileMode.UserWrite,
                    File.GetUnixFileMode(Path.Combine(directory, "credential.key")), "Key is owner-only");
            var config = new PluginConfiguration { ConnectorToken = token, ProtectedConnectorToken = encrypted };
            using var writer = new StringWriter();
            new System.Xml.Serialization.XmlSerializer(typeof(PluginConfiguration)).Serialize(writer, config);
            Assert(!writer.ToString().Contains(token), "XML excludes plaintext credential");
            Assert(!JsonSerializer.Serialize(config).Contains(token), "JSON excludes plaintext credential");
        }
        finally { Directory.Delete(directory, true); }
        return Task.CompletedTask;
    }

    private static Task TestConfigurationDefaults()
    {
        var cfg = new PluginConfiguration();
        Assert(!cfg.IsPaired, "New configuration must not be paired");
        AssertEqual(8, cfg.WorkerCount, "Default worker count should be 8");
        AssertEqual("https://samerow-v2.vercel.app", cfg.SameRowWebUrl, "Default web URL");

        cfg.ConnectorToken = "abc.123";
        cfg.GatewayUrl = "https://gateway.example.com";
        Assert(cfg.IsPaired, "Configuration with token and gateway should be paired");

        return Task.CompletedTask;
    }

    private static async Task TestProgressTrackingStreamFidelity()
    {
        byte[] original = new byte[256 * 1024]; // 256 KB
        RandomNumberGenerator.Fill(original);

        long trackedBytes = 0;
        using var memoryStream = new MemoryStream(original);
        using var trackingStream = new ProgressTrackingStream(memoryStream, b => Interlocked.Add(ref trackedBytes, b));

        using var destinationStream = new MemoryStream();
        await trackingStream.CopyToAsync(destinationStream);

        byte[] result = destinationStream.ToArray();
        AssertEqual(original.Length, result.Length, "Streamed byte length must match exactly");
        Assert(original.SequenceEqual(result), "Streamed binary bytes must match byte-for-byte");
        AssertEqual((long)original.Length, trackedBytes, "Tracked byte counter must match total transferred");
    }

    private static Task TestPathSecurity()
    {
        Assert(!SameRowConnectorService.IsAllowedRequest("POST", "/System/Configuration"), "Cloud cannot update server configuration");
        Assert(!SameRowConnectorService.IsAllowedRequest("DELETE", "/Users/admin"), "Cloud cannot delete users");
        Assert(!SameRowConnectorService.IsAllowedRequest("GET", "/SameRow/Status"), "Cloud cannot access plugin administration");
        Assert(SameRowConnectorService.IsAllowedRequest("GET", "/Videos/movie/hls1/a/0.mp4"), "Media is permitted");
        Assert(SameRowConnectorService.IsAllowedRequest("POST", "/Items/movie/PlaybackInfo"), "Playback negotiation is permitted");

        var invalidPaths = new[]
        {
            "",
            "relative/path",
            "/%2e%2e/secret",
            "/%252e%252e/secret",
            "/%5cother",
            "/safe#fragment",
            "//escaped/host",
            "/path/with/../traversal",
            "/path/with\\backslash",
            "http://169.254.169.254/latest/meta-data",
        };

        foreach (var path in invalidPaths)
        {
            bool isDisallowed = !SameRowConnectorService.IsValidResource(path);
            Assert(isDisallowed, $"Path '{path}' must be flagged as disallowed");
        }

        return Task.CompletedTask;
    }

    private static async Task TestRelayRangeRequestStreaming(bool json)
    {
        byte[] videoChunk = Encoding.UTF8.GetBytes(json ? "{\"Code\":\"123456\"}" : "BINARY_VIDEO_PAYLOAD_CHUNK_MOCK_1234567890");
        var mockLocalHandler = new MockHttpMessageHandler((req) =>
        {
            var res = new HttpResponseMessage(HttpStatusCode.PartialContent);
            res.Content = new ByteArrayContent(videoChunk);
            res.Content.Headers.ContentType = new MediaTypeHeaderValue(json ? "application/json" : "video/mp4");
            res.Content.Headers.ContentRange = new ContentRangeHeaderValue(0, videoChunk.Length - 1, videoChunk.Length);
            res.Headers.AcceptRanges.Add("bytes");
            return Task.FromResult(res);
        });

        HttpRequestMessage? uploadedResponse = null;
        byte[]? uploadedBody = null;
        string expectedJobId = "0123456789abcdef0123456789abcdef";

        int pollCallCount = 0;
        var mockCloudHandler = new MockHttpMessageHandler(async (req) =>
        {
            if (req.RequestUri!.PathAndQuery.Contains("/poll"))
            {
                pollCallCount++;
                if (pollCallCount == 1)
                {
                    var job = new RelayJob
                    {
                        Job = expectedJobId,
                        Method = "GET",
                        Resource = "/Videos/test/stream",
                        Headers = new Dictionary<string, string> { { "range", "bytes=0-1024" } },
                        DeviceId = "test-device",
                        ApiToken = "test-api-token"
                    };
                    var res = new HttpResponseMessage(HttpStatusCode.OK);
                    res.Content = new StringContent(JsonSerializer.Serialize(job), Encoding.UTF8, "application/json");
                    return res;
                }
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }

            if (req.RequestUri.PathAndQuery.Contains($"/response/{expectedJobId}"))
            {
                uploadedResponse = req;
                AssertEqual("application/octet-stream", req.Content?.Headers.ContentType?.MediaType, "Relay transport stays opaque");
                if (req.Content != null)
                {
                    uploadedBody = await req.Content.ReadAsByteArrayAsync();
                }
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        var factory = new MockHttpClientFactory(new Dictionary<string, HttpMessageHandler>
        {
            { "SameRowLoopback", mockLocalHandler },
            { "SameRowCloud", mockCloudHandler }
        });

        var mockAppHost = DuckProxy.Create<IServerApplicationHost>(p =>
        {
            p.Returns["get_HttpPort"] = 8096;
            p.Returns["get_CoreStartupHasCompleted"] = true;
        });

        var service = new SameRowConnectorService(mockAppHost, factory, NullLogger<SameRowConnectorService>.Instance);

        InitMockPlugin("https://cloud.example.com", $"{expectedJobId}.secret_digest");

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(3));
        await service.StartAsync(cts.Token);

        for (int i = 0; i < 20; i++)
        {
            if (uploadedResponse != null) break;
            await Task.Delay(100);
        }

        await service.StopAsync(CancellationToken.None);

        Assert(uploadedResponse != null, "Relay service must upload the response back to cloud");
        AssertEqual("206", uploadedResponse!.Headers.GetValues("X-Relay-Status").First(), "Status must be 206 Partial Content");

        string headersJson = uploadedResponse.Headers.GetValues("X-Relay-Headers").First();
        var headersDict = JsonSerializer.Deserialize<Dictionary<string, string>>(headersJson);
        Assert(headersDict!.ContainsKey("content-range"), "Content-Range header must be passed");
        Assert(headersDict.ContainsKey("accept-ranges"), "Accept-Ranges header must be passed");

        Assert(uploadedBody != null && videoChunk.SequenceEqual(uploadedBody), "Uploaded binary content must match local Jellyfin output exactly");
    }

    private static async Task TestRelayAuthFailure()
    {
        var mockCloudHandler = new MockHttpMessageHandler((req) =>
        {
            return Task.FromResult(new HttpResponseMessage(HttpStatusCode.Unauthorized));
        });

        var factory = new MockHttpClientFactory(new Dictionary<string, HttpMessageHandler>
        {
            { "SameRowLoopback", new MockHttpMessageHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK))) },
            { "SameRowCloud", mockCloudHandler }
        });

        var mockAppHost = DuckProxy.Create<IServerApplicationHost>(p =>
        {
            p.Returns["get_HttpPort"] = 8096;
            p.Returns["get_CoreStartupHasCompleted"] = true;
        });

        var service = new SameRowConnectorService(mockAppHost, factory, NullLogger<SameRowConnectorService>.Instance);

        InitMockPlugin("https://cloud.example.com", "0123456789abcdef0123456789abcdef.invalid");

        using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(2));
        await service.StartAsync(cts.Token);

        for (int i = 0; i < 15; i++)
        {
            if (service.State == ConnectorConnectionState.AuthenticationFailed) break;
            await Task.Delay(100);
        }

        var observedState = service.State;
        var observedError = service.LastError;

        await service.StopAsync(CancellationToken.None);

        AssertEqual(ConnectorConnectionState.AuthenticationFailed, observedState, "Service state must be AuthenticationFailed upon 401");
        Assert(!string.IsNullOrEmpty(observedError), "LastError should explain auth failure");
    }

    private static async Task TestControllerPairingWorkflow()
    {
        string expectedId = "aabbccddeeff00112233445566778899";
        string expectedToken = $"{expectedId}.{new string('a', 64)}";
        string? submittedClaim = null;
        string expectedGateway = "https://media.samerow.com";
        bool claimApproved = false;
        int rotations = 0;
        string? proposedCredential = null;

        var mockCloudHandler = new MockHttpMessageHandler(async (req) =>
        {
            if (req.RequestUri!.PathAndQuery.EndsWith("/approval/start"))
            {
                var body = await req.Content!.ReadFromJsonAsync<Dictionary<string, string>>();
                Assert(!string.IsNullOrEmpty(body?["claim"]), "Approval start must send sha256 claim");
                submittedClaim = body!["claim"];
                var res = new HttpResponseMessage(HttpStatusCode.OK);
                res.Content = new StringContent(JsonSerializer.Serialize(new { id = expectedId }), Encoding.UTF8, "application/json");
                return res;
            }

            if (req.RequestUri.PathAndQuery.EndsWith("/approval/claim"))
            {
                var body = await req.Content!.ReadFromJsonAsync<Dictionary<string, string>>();
                var hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(body!["secret"]))).ToLowerInvariant();
                AssertEqual(submittedClaim, hash, "Claim hash matches the actual server UTF8 protocol");
                if (!claimApproved)
                {
                    return new HttpResponseMessage(HttpStatusCode.Accepted);
                }
                var res = new HttpResponseMessage(HttpStatusCode.OK);
                res.Content = new StringContent(JsonSerializer.Serialize(new { token = expectedToken, gateway = expectedGateway }), Encoding.UTF8, "application/json");
                return res;
            }

            if (req.RequestUri.PathAndQuery.EndsWith("/rotate"))
            {
                var body = await req.Content!.ReadFromJsonAsync<Dictionary<string, string>>();
                var proposed = body!["token"];
                if (rotations++ == 0)
                {
                    proposedCredential = proposed;
                    return new HttpResponseMessage(HttpStatusCode.ServiceUnavailable);
                }
                AssertEqual(proposedCredential, proposed, "Retry reuses the saved proposed credential");
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }

            if (req.Method == HttpMethod.Delete && req.RequestUri.PathAndQuery.Contains($"/pair/{expectedId}"))
            {
                return new HttpResponseMessage(HttpStatusCode.NoContent);
            }

            return new HttpResponseMessage(HttpStatusCode.NotFound);
        });

        var factory = new MockHttpClientFactory(new Dictionary<string, HttpMessageHandler>
        {
            { "SameRowLoopback", new MockHttpMessageHandler(_ => Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK))) },
            { "SameRowCloud", mockCloudHandler }
        });

        var mockAppHost = DuckProxy.Create<IServerApplicationHost>(p =>
        {
            p.Returns["get_HttpPort"] = 8096;
            p.Returns["get_CoreStartupHasCompleted"] = true;
        });

        var service = new SameRowConnectorService(mockAppHost, factory, NullLogger<SameRowConnectorService>.Instance);
        var controller = new SameRowController(service, factory, NullLogger<SameRowController>.Instance);

        InitMockPlugin("", "");

        // 1. Initial status
        var statusResult = (OkObjectResult)controller.GetStatus().Result!;
        var initialJson = JsonDocument.Parse(JsonSerializer.Serialize(statusResult.Value)).RootElement;
        AssertEqual(false, initialJson.GetProperty("isPaired").GetBoolean(), "Initially isPaired must be false");

        // 2. Start Pairing
        var startResult = (ObjectResult)await controller.StartPairing(new StartPairingRequest
        {
            WebUrl = "https://samerow-v2.vercel.app",
            ControlUrl = "https://samerow-control.onrender.com"
        });
        AssertEqual(200, startResult.StatusCode, JsonSerializer.Serialize(startResult.Value));
        var startJson = JsonDocument.Parse(JsonSerializer.Serialize(startResult.Value)).RootElement;
        AssertEqual(expectedId, startJson.GetProperty("id").GetString(), "Returned id must match");
        Assert(startJson.GetProperty("approvalUrl").GetString()!.Contains(expectedId), "Approval URL must contain id");

        // 3. Claim before user approval -> 202 Accepted
        var pendingClaimResult = (ObjectResult)await controller.ClaimPairing(new ClaimPairingRequest { Id = expectedId });
        AssertEqual(202, pendingClaimResult.StatusCode, "Claim must return 202 while pending approval");

        // 4. User approves on web -> Claim returns 200 and saves credentials
        claimApproved = true;
        var successClaimResult = (OkObjectResult)await controller.ClaimPairing(new ClaimPairingRequest { Id = expectedId });
        var successJson = JsonDocument.Parse(JsonSerializer.Serialize(successClaimResult.Value)).RootElement;
        AssertEqual("paired", successJson.GetProperty("status").GetString(), "Status must be 'paired'");

        var config = Plugin.Instance!.Configuration;
        Assert(config.IsPaired, "Configuration must now be paired");
        AssertEqual(expectedToken, config.ConnectorToken, "Stored token must match");
        AssertEqual(expectedGateway, config.GatewayUrl, "Stored gateway must match");

        // Restart must create live workers rather than reusing a cancelled token.
        await service.RestartAsync();
        Assert(service.State is ConnectorConnectionState.Connecting or ConnectorConnectionState.Connected or ConnectorConnectionState.Reconnecting,
            "Re-pair restarts workers");

        var firstRotation = (ObjectResult)await controller.RotateCredential();
        AssertEqual(503, firstRotation.StatusCode, "Failed rotation remains retryable");
        Assert(!string.IsNullOrEmpty(config.PendingProtectedConnectorToken), "Proposed credential is saved encrypted before rotation");
        AssertEqual(expectedToken, config.ConnectorToken, "Current credential survives failed rotation");
        var retriedRotation = (OkObjectResult)await controller.RotateCredential();
        AssertEqual("rotated", JsonDocument.Parse(JsonSerializer.Serialize(retriedRotation.Value)).RootElement.GetProperty("status").GetString(), "Rotation succeeds on retry");
        AssertEqual(proposedCredential, config.ConnectorToken, "New credential is promoted");
        AssertEqual("", config.PendingProtectedConnectorToken, "Pending credential clears after success");

        // 5. Disconnect
        var disconnectResult = (OkObjectResult)await controller.Disconnect();
        var dcJson = JsonDocument.Parse(JsonSerializer.Serialize(disconnectResult.Value)).RootElement;
        AssertEqual("disconnected", dcJson.GetProperty("status").GetString(), "Status must be disconnected");
        Assert(!Plugin.Instance.Configuration.IsPaired, "Configuration must be cleared after disconnect");
    }

    private static async Task TestControllerSettings()
    {
        var factory = new MockHttpClientFactory(new Dictionary<string, HttpMessageHandler>());
        var mockAppHost = DuckProxy.Create<IServerApplicationHost>(p =>
        {
            p.Returns["get_HttpPort"] = 8096;
        });

        var service = new SameRowConnectorService(mockAppHost, factory, NullLogger<SameRowConnectorService>.Instance);
        var controller = new SameRowController(service, factory, NullLogger<SameRowController>.Instance);

        InitMockPlugin("", "");

        var result = await controller.UpdateSettings(new UpdateSettingsRequest
        {
            ServerFriendlyName = "Living Room Cinema",
            WorkerCount = 12,
            AllowedLibraryIds = Array.Empty<string>()
        });

        AssertEqual(200, ((OkObjectResult)result).StatusCode, "Settings update must return 200");
        var cfg = Plugin.Instance!.Configuration;
        AssertEqual("Living Room Cinema", cfg.ServerFriendlyName, "Friendly name must be updated");
        AssertEqual(12, cfg.WorkerCount, "Worker count must be updated");
        var unsupported = await controller.UpdateSettings(new UpdateSettingsRequest { AllowedLibraryIds = new[] { "lib1" } });
        Assert(unsupported is BadRequestObjectResult, "Unimplemented library restrictions must be rejected");
        await service.StopAsync(CancellationToken.None);
    }

    private static Task TestPluginMetadata()
    {
        var plugin = Plugin.Instance!;
        AssertEqual("SameRow Connect", plugin.Name, "Plugin Name");
        AssertEqual(Plugin.PluginId, plugin.Id, "Plugin GUID");
        var pages = plugin.GetPages().ToList();
        AssertEqual(1, pages.Count, "Must expose 1 configuration web page");
        AssertEqual("samerow", pages[0].Name, "Page name must be samerow");
        AssertEqual("SameRow.Plugin.Configuration.configPage.html", pages[0].EmbeddedResourcePath, "Embedded resource path");
        return Task.CompletedTask;
    }

    private static void InitMockPlugin(string gateway, string token)
    {
        var mockPaths = DuckProxy.Create<IApplicationPaths>(p =>
        {
            p.Returns["get_PluginsPath"] = "/tmp/jellyfin/plugins";
            p.Returns["get_PluginConfigurationsPath"] = "/tmp/jellyfin/configurations";
            p.Returns["get_ConfigurationDirectoryPath"] = "/tmp/jellyfin/config";
            p.Returns["get_ProgramDataPath"] = "/tmp/jellyfin/data";
            p.Returns["get_DataPath"] = "/tmp/jellyfin/data";
        });
        var mockXml = DuckProxy.Create<IXmlSerializer>(p =>
        {
            p.Returns["DeserializeFromFile"] = new PluginConfiguration();
        });
        var plugin = new Plugin(mockPaths, mockXml);
        plugin.Configuration.GatewayUrl = gateway;
        plugin.Configuration.ConnectorToken = token;
        plugin.Configuration.ConnectorId = token.Split('.').FirstOrDefault() ?? "";
    }
}

public class DuckProxy : DispatchProxy
{
    public Dictionary<string, object?> Returns { get; } = new();

    protected override object? Invoke(MethodInfo? targetMethod, object?[]? args)
    {
        if (targetMethod == null) return null;
        if (targetMethod.ReturnType == typeof(void)) return null;
        if (Returns.TryGetValue(targetMethod.Name, out var val)) return val;
        if (targetMethod.ReturnType == typeof(string)) return "";
        if (targetMethod.ReturnType == typeof(int)) return 8096;
        if (targetMethod.ReturnType == typeof(bool)) return false;
        if (targetMethod.ReturnType == typeof(Task)) return Task.CompletedTask;
        if (targetMethod.ReturnType.IsValueType) return Activator.CreateInstance(targetMethod.ReturnType);
        return null;
    }

    public static T Create<T>(Action<DuckProxy>? configure = null) where T : class
    {
        var proxy = Create<T, DuckProxy>();
        configure?.Invoke((DuckProxy)(object)proxy);
        return proxy;
    }
}

internal class MockHttpMessageHandler : HttpMessageHandler
{
    private readonly Func<HttpRequestMessage, Task<HttpResponseMessage>> _handler;

    public MockHttpMessageHandler(Func<HttpRequestMessage, Task<HttpResponseMessage>> handler)
    {
        _handler = handler;
    }

    protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken)
    {
        return _handler(request);
    }
}

internal class MockHttpClientFactory : IHttpClientFactory
{
    private readonly Dictionary<string, HttpMessageHandler> _handlers;

    public MockHttpClientFactory(Dictionary<string, HttpMessageHandler> handlers)
    {
        _handlers = handlers;
    }

    public HttpClient CreateClient(string name)
    {
        if (_handlers.TryGetValue(name, out var handler))
        {
            return new HttpClient(handler, disposeHandler: false);
        }
        return new HttpClient();
    }
}


// Real network clients for the loopback integration harness. Production plugin
// registration uses the same redirect, decompression and cookie policies.
internal sealed class RealHttpClientFactory : IHttpClientFactory
{
    public HttpClient CreateClient(string name) => new(new SocketsHttpHandler
    {
        AllowAutoRedirect = false,
        AutomaticDecompression = DecompressionMethods.None,
        UseCookies = false,
        ConnectTimeout = TimeSpan.FromSeconds(15)
    }) { Timeout = Timeout.InfiniteTimeSpan };
}
