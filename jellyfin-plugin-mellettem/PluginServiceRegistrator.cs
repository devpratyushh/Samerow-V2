// Copyright (c) 2026 devpratyushh
// SPDX-License-Identifier: GPL-3.0-or-later

using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;
using Mellettem.Plugin.Services;

namespace Mellettem.Plugin;

/// <summary>
/// Registers Mellettem plugin services into Jellyfin's dependency injection container.
/// </summary>
public class PluginServiceRegistrator : IPluginServiceRegistrator
{
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddHttpClient("MellettemLoopback", client =>
        {
            client.Timeout = Timeout.InfiniteTimeSpan;
        }).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = System.Net.DecompressionMethods.None,
            UseCookies = false,
            ConnectTimeout = TimeSpan.FromSeconds(15)
        });

        serviceCollection.AddHttpClient("MellettemCloud", client =>
        {
            client.Timeout = Timeout.InfiniteTimeSpan;
        }).ConfigurePrimaryHttpMessageHandler(() => new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            AutomaticDecompression = System.Net.DecompressionMethods.None,
            UseCookies = false,
            ConnectTimeout = TimeSpan.FromSeconds(15)
        });

        serviceCollection.AddSingleton<MellettemConnectorService>();
        serviceCollection.AddHostedService(sp => sp.GetRequiredService<MellettemConnectorService>());
    }
}
