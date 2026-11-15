// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using Mellettem.Plugin.Configuration;
using Mellettem.Plugin.Services;

namespace Mellettem.Plugin;

/// <summary>
/// The main Mellettem Connect plugin instance.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid PluginId = Guid.Parse("a14b5c7e-8d90-4123-b567-9876543210ab");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        var keyDirectory = System.IO.Path.Combine(applicationPaths.PluginConfigurationsPath, "Mellettem");
        var legacyDirectory = System.IO.Path.Combine(applicationPaths.PluginConfigurationsPath, "SameRow");
        _credentials = new CredentialVault(System.IO.File.Exists(System.IO.Path.Combine(keyDirectory, "credential.key"))
            || !System.IO.File.Exists(System.IO.Path.Combine(legacyDirectory, "credential.key"))
            ? keyDirectory : legacyDirectory);
        if (!string.IsNullOrEmpty(Configuration.ProtectedConnectorToken))
            Configuration.ConnectorToken = _credentials.Unprotect(Configuration.ProtectedConnectorToken);
        else if (!string.IsNullOrEmpty(Configuration.ConnectorToken))
            SaveConnectorConfiguration();
    }

    private readonly CredentialVault _credentials;

    public void SaveConnectorConfiguration()
    {
        Configuration.ProtectedConnectorToken = _credentials.Protect(Configuration.ConnectorToken);
        SaveConfiguration();
    }

    public string PendingCredential
    {
        get => _credentials.Unprotect(Configuration.PendingProtectedConnectorToken);
        set => Configuration.PendingProtectedConnectorToken = _credentials.Protect(value);
    }

    /// <summary>
    /// Gets the current plugin instance.
    /// </summary>
    public static Plugin? Instance { get; private set; }

    /// <inheritdoc />
    public override string Name => "Mellettem Connect";

    // Jellyfin derives this from the assembly name unless it is overridden.
    public override string ConfigurationFileName => "SameRow.Plugin.xml";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description => "Connect your Jellyfin server directly to Mellettem for watch parties without port forwarding.";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "mellettem",
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
                DisplayName = "Mellettem Connect",
                EnableInMainMenu = true,
                MenuSection = "server",
                MenuIcon = "favorite"
            }
        };
    }
}
