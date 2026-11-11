# SameRow Jellyfin pilot walkthrough

One host runs Docker on a computer that can reach their Jellyfin server. Up to
three guests join through the regular SameRow website. Only the host installs
Docker and signs in to Jellyfin.

## 1. Set up the hosted pilot

On Render, use the control service, a **single media replica**, and shared Redis.
Apply the [production setup](production.md#configure-services) for Firebase,
LiveKit, and Vercel. In the shared Render environment group set
`MAX_ROOM_SIZE=4` and `JELLYFIN_RELAY_ENABLED=true`. Deploy both Render services
and the Vercel frontend from the same revision.

Open `/health/ready` on both Render services. On the control service, open
`/api/config` and confirm it reports `"maxRoomSize": 4` and
`"jellyfinRelay": true`. Start with a fresh room for the pilot.

## 2. Pair the host's container

1. Open the hosted SameRow website and **Continue with Google**.
2. Expand **Host from your Jellyfin Docker container** in the lobby.
3. Choose **Pair Docker connector**. Save the generated connector settings and
   the separate **Jellyfin address for SameRow Web**. Keep the token private.
4. On the Docker host, create a file named `.env.pilot` in the repository root.
   Replace the examples below with the host's Jellyfin URL and the pairing
   values from the website.

   ```dotenv
   JELLYFIN_ALLOWED_ORIGINS=http://192.168.1.50:8096
   SAMEROW_CONNECTOR_JELLYFIN_URL=http://192.168.1.50:8096
   SAMEROW_CONNECTOR_GATEWAY=https://your-render-media-service.example
   SAMEROW_CONNECTOR_TOKEN=replace-with-generated-token
   ```

   If Jellyfin is on the Docker host, use
   `http://host.docker.internal:8096` for the two Jellyfin settings. If it uses a
   base path, include that path in `SAMEROW_CONNECTOR_JELLYFIN_URL` and leave it
   out of the origin allowlist. See the [local networking guide](local-edition.md#start-on-one-computer).

5. Start the container from the repository root.

   ```sh
   docker compose --env-file .env.pilot -f compose.local.yaml up --build -d
   docker compose --env-file .env.pilot -f compose.local.yaml ps
   ```

## 3. Start a movie and invite guests

1. In the hosted lobby, choose **Generate private room code** under the Docker
   hosting panel. Enter your name and select **Enter room**.
2. Choose **Share something → Your Jellyfin library**. Enter the generated
   **Jellyfin address for SameRow Web** and sign in to Jellyfin or use
   Quick Connect. Pick a movie. Start with **Auto** quality.
3. Use the room's invite button and send the **full link** to one guest first.
   The four-character code identifies the room. The rest of the invite link
   lets guests enter the private room.
4. Have the guest open the link on a different internet connection, such as
   mobile data. They enter a name and join in their browser.

## 4. Check the four-person limit

- With one guest, check video and audio, pause and resume, and try a seek.
- Add two more guests. Watch together for several minutes and check whether
  playback stays smooth when someone reloads and rejoins.
- Try joining from a fifth browser while all four seats are occupied. It should
  report that the room is full. Have someone leave, then try joining again.
- Use **Stop movie for everyone** when done and confirm guests lose playback.

The pilot pulls media separately for each viewer. For example, four streams at
8 Mbps could use about 32 Mbps of the host's upload. If playback buffers with
more guests, use lower quality or run the session with fewer viewers. Four
seats are an admission limit.

If the web app says the connector is offline, check that the Docker container
is running, its configured gateway points to the Render **media** service, and
it can reach the local Jellyfin URL. Pairings expire after 30 days. For a new
pairing, update the container settings and use the newly generated Jellyfin
address in the web app.
