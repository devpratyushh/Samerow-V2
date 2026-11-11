# SameRow Local for Jellyfin

Run SameRow on a computer or NAS that can reach your Jellyfin server. The
container serves the web app, room server, and Jellyfin gateway at one address.
Browsers stream through SameRow, so they never need to call Jellyfin directly
or change its CORS settings. No Firebase, Redis, or LiveKit account is required.

## Start on one computer

Install Docker with Compose. From the repository root, set the Jellyfin origin
to the scheme, host, and port the **container** can reach.

```sh
JELLYFIN_ALLOWED_ORIGINS=http://192.168.1.50:8096 docker compose -f compose.local.yaml up --build -d
```

Open [http://localhost:8080](http://localhost:8080), enter a name and room code,
then choose **Share something → Your Jellyfin library**. Enter the same Jellyfin
address and sign in or use Quick Connect. If Jellyfin has a base path such as
`/jellyfin`, include it in the address you enter in SameRow and leave it out of
the origin allowlist.

- Jellyfin on another device: use that device's LAN IP or a hostname the container can resolve.
- Jellyfin on the Docker host: use `http://host.docker.internal:8096`. Compose provides a host gateway alias for Linux. Jellyfin must listen on an interface reachable from Docker.
- Jellyfin in another container: use its published host port via `host.docker.internal`, or put both containers on the same Docker network and use the Jellyfin service name. Inside SameRow's container, `localhost` refers to SameRow's own container.

## Let other devices on your LAN join

The default port binding is loopback. To share, replace the two example IPs
below with the Docker host's LAN IP and Jellyfin's address, respectively.

```sh
SAMEROW_BIND_IP=192.168.1.20 \
SAMEROW_ORIGINS=http://192.168.1.20:8080 \
JELLYFIN_ALLOWED_ORIGINS=http://192.168.1.50:8096 \
docker compose -f compose.local.yaml up --build -d
```

Everyone opens `http://192.168.1.20:8080` and enters the same room code.
Only the person sharing the movie needs a Jellyfin account. If you change
`SAMEROW_PORT`, update the port in `SAMEROW_ORIGINS` too.

This edition is for a trusted network. Anyone who can reach SameRow can
join with a room code, and plain HTTP does not encrypt sign-in or playback
traffic on the LAN. Camera, microphone, and screen capture require a secure
browser context such as localhost or trusted HTTPS. The bundled mesh setup
has a four-person room limit. Room state resets on restart, while remembered
Jellyfin connections are stored in the Docker volume.

## Host for guests on SameRow Web

Follow the [Jellyfin pilot walkthrough](jellyfin-pilot.md) to pair the container,
create a private hosted room, and invite up to three guests.
