# Watch Jellyfin with friends over the internet

You run Jellyfin at home. Your friends open a SameRow link in their browser.
**Only you install Docker and sign in to Jellyfin.** A room fits you and up to
three friends. You start the room and control the movie from SameRow Local.

The connector is a small part of SameRow that runs in Docker next to Jellyfin.
It calls SameRow over the internet and fetches the movie from Jellyfin when
someone in your room presses play. Keep the server on while you watch. You
don't need to open a port on your router.

![Jellyfin sends the movie through the Docker connector to friends watching on SameRow Web](images/jellyfin-connector-flow.svg)

## 1. Get Docker and download SameRow

Open a terminal **on your Jellyfin server**, or connect to it with SSH. You can
also use another computer that can reach Jellyfin. If you already run Jellyfin
in Docker, check whether Compose is installed before installing anything.

Follow [Install Docker on your server](local-edition.md#install-docker-on-your-server).
Then run these two lines in the server terminal:

```sh
git clone https://github.com/devpratyushh/Samerow-V2.git
cd Samerow-V2
```

If you already downloaded SameRow, open that folder. Keep using this terminal
for the commands below.

## 2. Pair the connector

1. On your computer, open [SameRow Web](https://samerow-v2.vercel.app/) and
   choose **Continue with Google**.
2. Open **Host from your Jellyfin Docker container** and click **Pair Docker
   connector** once.
3. Copy the two lines in **Docker connector settings**. You'll paste both
   into the settings file in step 3. Keep the token private.

![Copy the gateway and token from the pairing panel into your server’s .env.pilot file](images/jellyfin-pairing-copy-guide.svg)

## 3. Start the connector on your server

Already running SameRow Local at `http://localhost:8080`? You can add the
connector settings to `.env.local-docker` and use that filename in the commands
below. If your existing setup listens on a LAN address or a different port,
follow the [web hosting option](#host-from-samerow-web) to use the connector
with that installation.

In the server terminal, make a private settings file and open it:

```sh
touch .env.pilot
chmod 600 .env.pilot
nano .env.pilot
```

If Jellyfin runs on this server and uses port 8096, put these two lines in the
file. If Jellyfin runs on a different computer, replace
`host.docker.internal` on both lines with that computer's local IP address.

```dotenv
JELLYFIN_ALLOWED_ORIGINS=http://host.docker.internal:8096
SAMEROW_CONNECTOR_JELLYFIN_URL=http://host.docker.internal:8096
SAMEROW_CONNECTOR_HOST_ENABLED=true
```

Below those lines, paste the **two Docker connector settings** lines from
step 2. A new file should have five lines. In Nano, press **Ctrl+O**, **Enter**,
then **Ctrl+X** to save and close. If your Jellyfin address uses another port or
a path such as `/jellyfin`, see [which address to use](local-edition.md#1-choose-your-jellyfin-address).
Use the full address for `SAMEROW_CONNECTOR_JELLYFIN_URL` and leave the path
off `JELLYFIN_ALLOWED_ORIGINS`.

Run:

```sh
docker compose --env-file .env.pilot -f compose.local.yaml up --build -d
docker compose --env-file .env.pilot -f compose.local.yaml ps
```

The first run can take a few minutes. Look for **Up** next to `samerow`.
If Docker says you don't have permission, use `sudo docker compose` for
these commands on Linux. Once it's up, you can close the terminal.

## 4. Play a movie and invite friends

1. Open [SameRow Local](http://localhost:8080/) and click **Host for friends
   online**. SameRow gives you a four-letter private room code.
2. Enter your name and click **Enter room**.
3. Click **+ → Your Jellyfin library**. The server address is already filled
   in. Sign in with your Jellyfin account or use Quick Connect. Pick a movie
   and start with **Auto** quality.
4. Click **Invite friends** and send the **whole link**. Your friends open it,
   enter a name, and click **Enter room**. The short room code alone cannot
   open a private room.

Try it with one friend first, ideally on another network. Check picture,
sound, and pause. Use **Stop movie for everyone** when you're done.

If Docker runs on another machine, open a terminal **on the computer where you
watch** and run this command with your server's SSH username and address.
Keep the terminal open while you use [SameRow Local](http://localhost:8080/).

```sh
ssh -N -L 8080:127.0.0.1:8080 your-user@your-server
```

### Host from SameRow Web

For an existing LAN installation, add the Jellyfin address and the two pairing
lines to its settings file and skip `SAMEROW_CONNECTOR_HOST_ENABLED=true`.
Restart using the Compose command above and the filename for that installation.
Sign in to SameRow Web with the Google account you used to pair and click
**Generate private room code → Enter room**. Open **Your Jellyfin library** and
paste the **Jellyfin address for SameRow Web** from the pairing panel before
signing in. Share the full invite link.

## If it doesn't work

| What you see | What to do |
| --- | --- |
| The Docker hosting panel is missing | Check that you signed in with Google on SameRow Web. The site also needs the Jellyfin relay enabled. |
| **Host for friends online** is missing | Rebuild with the command in step 3, check that `SAMEROW_CONNECTOR_HOST_ENABLED=true` is in the settings file, and open `http://localhost:8080`. |
| The connector is offline or busy | Run the status command from step 3. If the container is up, check its logs and confirm the Jellyfin address, gateway, and token in `.env.pilot`. |
| The pairing stopped working | Pairings expire after 30 days. Pair again, replace the gateway and token in `.env.pilot`, and rerun the start command. If you shared the token by accident and still have the pairing panel open, use **Revoke this connector**. |
| The movie buffers | Try **Auto** or a lower quality, or test with fewer guests. Your home upload carries a separate stream for each viewer. |

To read the connector's logs:

```sh
docker compose --env-file .env.pilot -f compose.local.yaml logs --tail=100 samerow
```

## Technical details for SameRow operators

The connector makes outbound HTTPS requests to the Render media service. The
media service checks room access and passes each request to the connector,
which fetches the media from Jellyfin. The private invite has a separate secret
from the room code. Four streams at 8 Mbps each can use about 32 Mbps of the
host's upload.

If you run your own SameRow Web deployment, follow the
[production setup](production.md#configure-services). Use one media replica and
shared Redis, set `MAX_ROOM_SIZE=4` and `JELLYFIN_RELAY_ENABLED=true` on both
Render services, and check `/health/ready` on both. The control service's
`/api/config` should report `"maxRoomSize": 4` and `"jellyfinRelay": true`.
Use matching versions of the Docker app and both Render services. To use your
own deployment, set `SAMEROW_HOSTED_CONTROL_URL` to the control service origin
and `SAMEROW_HOSTED_WEB_ORIGIN` to the guest website origin in your Docker
settings file. Keep the online host app bound to `127.0.0.1:8080`.
