# Run SameRow with Docker

Use SameRow Local to watch from a Jellyfin library on your home network. Run
the container on a computer or NAS that can reach Jellyfin. Guests on the
same network open SameRow in a browser. Only the person sharing the movie
needs a Jellyfin account.

## Install Docker on your server

Open a terminal on the computer that will run SameRow. If you're using a
different computer, connect to the server over SSH first. Docker runs SameRow.
Compose is the command that starts it using the settings in this repo.

1. Run `docker compose version`. If it prints a version, Docker Compose is
   already installed. Skip to step 3.
2. On Linux, run `cat /etc/os-release` if you don't know what your server
   runs. Follow Docker's **Install using the apt repository** steps for
   [Ubuntu](https://docs.docker.com/engine/install/ubuntu/#install-using-the-apt-repository)
   or [Debian](https://docs.docker.com/engine/install/debian/#install-using-the-apt-repository).
   Install the Compose plugin with Docker Engine as shown there. If Docker
   Engine is already installed but Compose is missing, use the
   [Compose plugin guide](https://docs.docker.com/compose/install/linux/).
   For a NAS, use its Docker or container app if it provides the Compose
   command. For other systems, see [Docker's installation guide](https://docs.docker.com/engine/install/).
3. Run `docker compose version` and `docker info`. The first checks Compose.
   The second checks that Docker is running. On Linux, if Docker reports a
   permission error, run `sudo docker info` and use `sudo docker compose` in the
   commands below. If Git or Nano is missing on Ubuntu or Debian, install
   them with `sudo apt update && sudo apt install git nano`. Git downloads
   SameRow. Nano opens the settings file.

## 1. Choose your Jellyfin address

In the server terminal, download SameRow if you haven't already:

```sh
git clone https://github.com/devpratyushh/Samerow-V2.git
cd Samerow-V2
```

Choose the address the SameRow **container** will use to reach Jellyfin.

| Where Jellyfin runs | Address to use |
| --- | --- |
| A different computer or NAS | Its LAN address, such as `http://192.168.1.50:8096`. |
| On the Docker host, including a container with a published port | `http://host.docker.internal:8096`, with the host port Jellyfin publishes or listens on. The Compose file adds a host gateway alias for Linux. Jellyfin must listen on an interface Docker can reach. |
| In a separate container on a shared Docker network | The service name and container port, such as `http://jellyfin:8096`. Both services must join that Docker network. |

Inside SameRow's container, `localhost` refers to the SameRow container. If
Jellyfin uses a base path such as `/jellyfin`, leave that path out of
`JELLYFIN_ALLOWED_ORIGINS` and include it when you sign in through SameRow.

## 2. Build and start SameRow

In the SameRow folder, run `nano .env.local-docker`. Paste the line below
and replace the example with your Jellyfin address. Leave off any path after
the port. Press **Ctrl+O**, **Enter**, then **Ctrl+X** to save and close.

```dotenv
JELLYFIN_ALLOWED_ORIGINS=http://192.168.1.50:8096
```

Run:

```sh
docker compose --env-file .env.local-docker -f compose.local.yaml up --build -d
docker compose --env-file .env.local-docker -f compose.local.yaml ps
```

Compose builds the image from this repository. Open
[http://localhost:8080](http://localhost:8080) on the Docker host. After SameRow
connects, it fills in a random four-character room code. Enter your name,
select **Enter room**, then choose **Share something → Your Jellyfin library**.
Enter the Jellyfin address from step 1 and sign in or use Quick Connect. Pick
a movie to test playback.

## 3. Invite other devices on your home network

SameRow initially listens on the Docker host only. To let people on your
network join, add these lines to `.env.local-docker`. Replace the example IP
with the **Docker host's** LAN IP.

```dotenv
SAMEROW_BIND_IP=192.168.1.20
SAMEROW_ORIGINS=http://192.168.1.20:8080
```

Run the same `docker compose ... up --build -d` command from step 2. Open
SameRow using the new LAN address. Guests should open the invite link or visit
`http://192.168.1.20:8080` and replace the code in the lobby with yours.
Each room fits up to four people, including the host. If you set
`SAMEROW_PORT` to use a different port, include the new port in
`SAMEROW_ORIGINS` and in the address you share.

Use LAN mode on a trusted network. Anyone who can reach it can enter a public
room by code. Plain HTTP does not encrypt traffic. Browsers require a secure
context, such as localhost or trusted HTTPS, for camera, microphone, and
screen capture.

## Host for guests on SameRow Web

If guests are outside your home network, choose **Host for friends online**
in SameRow Local. Approve the connection in your browser the first time.
Then start the movie and copy the web invite link from the local room. Only
the host installs Docker, and the container connects outbound. Follow the
[hosted pilot walkthrough](jellyfin-pilot.md) for pairing and deployment.

## Operate and troubleshoot

| What you see | What to check |
| --- | --- |
| The container keeps restarting | Read its logs with the command below. Check that `JELLYFIN_ALLOWED_ORIGINS` contains the exact Jellyfin scheme, host, and port without a path. |
| SameRow opens on the host but guests cannot reach it | Check the LAN bind address and port, the host firewall, and whether both devices are on the same network. Open the address configured in `SAMEROW_ORIGINS`. |
| The library won't connect | Check the address from the container's point of view. Use the Jellyfin host's IP or `host.docker.internal` as appropriate. The address entered in SameRow must use the configured origin. |
| Playback buffers | Try **Auto** or a lower quality. Each viewer pulls their own stream, so available bandwidth and Jellyfin's transcoding capacity affect playback. |

To inspect logs or stop the container:

```sh
docker compose --env-file .env.local-docker -f compose.local.yaml logs --tail=100 samerow
docker compose --env-file .env.local-docker -f compose.local.yaml down
```

To update, pull the latest repository changes and repeat the build command
in step 2. The named Docker volume keeps remembered Jellyfin connections across
rebuilds and ordinary stops. Room state resets on restart. Removing the volume
with `down -v` also removes remembered connections.

## How the Docker edition works

The image runs the React frontend, Node room service, and Jellyfin gateway at
one address. SameRow connects to the configured Jellyfin origin from inside
the container. Viewers fetch media through SameRow, so Jellyfin's CORS settings
can stay as they are. For LAN mode there is no Firebase, Redis, or LiveKit
account to configure. The optional hosted connector uses the infrastructure in
the [production runbook](production.md).
