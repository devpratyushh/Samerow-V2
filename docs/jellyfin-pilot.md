# SameRow Jellyfin pilot walkthrough

Watch a movie from the host's Jellyfin library together on the SameRow website.
A room fits **one host and up to three guests**. Guests need the invite link
and a browser. The host needs a Jellyfin account and a [one-time Docker setup](#set-up-the-hosts-docker-container).

## Host a movie night

1. Open SameRow Web and **Continue with Google**. In the lobby, expand **Host
   from your Jellyfin Docker container**.
2. Choose **Generate private room code**. Enter your name and select
   **Enter room**.
3. Choose **Share something → Your Jellyfin library**. Use the **Jellyfin
   address for SameRow Web** saved during setup. Sign in to Jellyfin or use
   Quick Connect, then pick a movie. Start with **Auto** quality.
4. Use the room's invite button to send guests the **full link**. They need
   the link to enter the private room. The four-character code helps identify
   the room.
5. When you're done, select **Stop movie for everyone**.

## Join as a guest

Open the invite link, enter your name, and select **Enter room**. You'll watch
in your browser without a Jellyfin account. If the room is full, wait for
someone to leave and try again.

## Try it with your group

Start with one guest on another internet connection, such as mobile data.
Check that you both get picture and sound. Pause, resume, and skip ahead to
see whether playback stays in sync. Then invite the other two guests and
have someone reload and rejoin. If playback keeps buffering, try a lower
quality or continue with fewer guests.

## Technical setup and background

### Deploy the hosted pilot

On Render, use the control service, a **single media replica**, and shared
Redis. Follow the [production setup](production.md#configure-services) for
Firebase, LiveKit, and Vercel. In the shared Render environment group set
`MAX_ROOM_SIZE=4` and `JELLYFIN_RELAY_ENABLED=true`. Deploy both Render services
and the Vercel frontend from the same revision.

Open `/health/ready` on both Render services. On the control service, check
that `/api/config` reports `"maxRoomSize": 4` and `"jellyfinRelay": true`.

### Set up the host's Docker container

1. Sign in with Google on SameRow Web. Expand **Host from your Jellyfin Docker
   container** and choose **Pair Docker connector**. Save the generated
   connector settings and the separate **Jellyfin address for SameRow Web**.
   Keep the token private.
2. On the Docker host, create a file named `.env.pilot` in the repository root.
   Replace the examples with the Jellyfin URL that the container can reach and
   the pairing values from SameRow Web.

   ```dotenv
   JELLYFIN_ALLOWED_ORIGINS=http://192.168.1.50:8096
   SAMEROW_CONNECTOR_JELLYFIN_URL=http://192.168.1.50:8096
   SAMEROW_CONNECTOR_GATEWAY=https://your-render-media-service.example
   SAMEROW_CONNECTOR_TOKEN=replace-with-generated-token
   ```

   If Jellyfin runs on the Docker host, use `http://host.docker.internal:8096`
   for the two Jellyfin settings. If Jellyfin uses a base path, include it in
   `SAMEROW_CONNECTOR_JELLYFIN_URL` and leave it out of the origin allowlist.
   See the [local networking guide](local-edition.md#start-on-one-computer).

3. From the repository root, start the container and check its status.

   ```sh
   docker compose --env-file .env.pilot -f compose.local.yaml up --build -d
   docker compose --env-file .env.pilot -f compose.local.yaml ps
   ```

### How playback reaches guests

The connector makes outbound HTTPS requests to the Render media service. When
a viewer requests video, the media service checks room access and sends the
request through the connector to the host's Jellyfin server. Guests receive
video from SameRow over HTTPS. The private invite link carries a separate
secret from the four-character room code.

The pilot fetches media separately for each viewer. Four streams at 8 Mbps
could use about 32 Mbps of the host's upload. The four-seat cap controls room
admission. Playback quality still depends on available upload bandwidth.

### Verify and troubleshoot

- Fill a fresh room with four people. A fifth browser should see that the
  room is full. After someone leaves, that browser should be able to join.
- Stop the movie for everyone and confirm guests lose playback.
- If the connector appears offline, check that the container is running,
  the gateway points to the Render **media** service, and the container can
  reach the Jellyfin URL.
- Pairings expire after 30 days. After pairing again, update the container
  settings, restart it, and use the new Jellyfin address in SameRow Web.
