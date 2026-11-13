using System;
using System.Collections.Generic;
using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Plugins;
using MediaBrowser.Model.Serialization;
using SameRow.Plugin.Configuration;
using SameRow.Plugin.Services;

namespace SameRow.Plugin;

/// <summary>
/// The main SameRow Connect plugin instance.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>, IHasWebPages
{
    public static readonly Guid PluginId = Guid.Parse("a14b5c7e-8d90-4123-b567-9876543210ab");

    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
        _credentials = new CredentialVault(System.IO.Path.Combine(applicationPaths.PluginConfigurationsPath, "SameRow"));
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
    public override string Name => "SameRow Connect";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description => "Connect your Jellyfin server directly to SameRow for watch parties without port forwarding.";

    /// <inheritdoc />
    public IEnumerable<PluginPageInfo> GetPages()
    {
        return new[]
        {
            new PluginPageInfo
            {
                Name = "samerow",
                EmbeddedResourcePath = $"{GetType().Namespace}.Configuration.configPage.html",
                DisplayName = "SameRow Connect",
                EnableInMainMenu = true,
                MenuSection = "server",
                MenuIcon = "play_circle_filled"
            }
        };
    }
}
