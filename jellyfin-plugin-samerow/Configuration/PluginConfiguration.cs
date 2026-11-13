// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using MediaBrowser.Model.Plugins;
using System.Xml.Serialization;
using System.Text.Json.Serialization;

namespace SameRow.Plugin.Configuration;

/// <summary>
/// Configuration for the SameRow Connect Jellyfin plugin.
/// Stored in Jellyfin's plugin configurations directory.
/// </summary>
public class PluginConfiguration : BasePluginConfiguration
{
    public PluginConfiguration()
    {
        GatewayUrl = string.Empty;
        ConnectorToken = string.Empty;
        ConnectorId = string.Empty;
        SameRowWebUrl = "https://samerow-v2.vercel.app";
        SameRowControlUrl = "https://samerow-v2.onrender.com";
        ServerFriendlyName = string.Empty;
        AllowedLibraryIds = Array.Empty<string>();
        WorkerCount = 8;
        AutoStart = true;
    }

    /// <summary>
    /// Gets or sets the HTTPS gateway URL for SameRow Cloud relay.
    /// </summary>
    public string GatewayUrl { get; set; }

    /// <summary>
    /// Gets or sets the private authenticated connector bearer token (id.digest).
    /// </summary>
    [XmlIgnore, JsonIgnore]
    public string ConnectorToken { get; set; }

    public string ProtectedConnectorToken { get; set; } = string.Empty;
    public string PendingProtectedConnectorToken { get; set; } = string.Empty;

    // Read old configuration once, then omit the plaintext element on every save.
    [XmlElement("ConnectorToken"), JsonIgnore]
    public string? LegacyConnectorToken { get => null; set => ConnectorToken = value ?? ""; }
    public bool ShouldSerializeLegacyConnectorToken() => false;

    /// <summary>
    /// Gets or sets the unique 32-character hexadecimal connector identifier.
    /// </summary>
    public string ConnectorId { get; set; }

    /// <summary>
    /// Gets or sets the hosted SameRow Web client origin.
    /// </summary>
    public string SameRowWebUrl { get; set; }

    /// <summary>
    /// Gets or sets the optional control service origin override.
    /// </summary>
    public string SameRowControlUrl { get; set; }

    /// <summary>
    /// Gets or sets a custom friendly name for this server on SameRow.
    /// </summary>
    public string ServerFriendlyName { get; set; }

    /// <summary>
    /// Gets or sets the library collection IDs allowed to be browsed by SameRow viewers.
    /// When empty, all libraries accessible by the paired administrator are discoverable.
    /// </summary>
    public string[] AllowedLibraryIds { get; set; }

    /// <summary>
    /// Gets or sets the number of concurrent long-poll worker loops (default 8).
    /// </summary>
    public int WorkerCount { get; set; }

    /// <summary>
    /// Gets or sets whether the connector automatically connects on Jellyfin startup.
    /// </summary>
    public bool AutoStart { get; set; }

    /// <summary>
    /// Gets or sets the timestamp when the server was paired.
    /// </summary>
    public DateTime? PairedAt { get; set; }

    /// <summary>
    /// Indicates whether the plugin is currently paired.
    /// </summary>
    public bool IsPaired => !string.IsNullOrEmpty(ConnectorToken) && !string.IsNullOrEmpty(GatewayUrl);
}
