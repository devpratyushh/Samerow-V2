# Mellettem Connect 1.0.7.0

A consistent Mellettem identity across the web app, Jellyfin plugin, catalog, and project documentation.

- New supplied logo in the web lobby, room header, browser icons, link previews, plugin package, and catalog.
- Rewritten product README and architecture guide explaining direct WebRTC HLS delivery, HTTPS fallback, separate room control, and LiveKit calls.
- Existing account pairing and the catalog address remain compatible. Restart Jellyfin after updating.
- The accompanying application revision improves compatible-playback startup and enforces transcoding when a lower bitrate cannot be achieved by stream-copy.

Requires Jellyfin 12.3 / .NET 10. This is a public beta. Direct transport depends on browser and network support; HTTPS fallback remains available. Separate-network, physical iOS, HDR, and regular Firefox acceptance limits are documented in `docs/direct-media.md`.

The release includes the plugin, platform sender binaries, dependency notices, corresponding GPL source, and SHA-256 checksums. The catalog is updated only after the published downloads are verified.
