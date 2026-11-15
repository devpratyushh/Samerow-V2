// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"net/url"
	"strings"
	"testing"
)

func TestRewriteScopedPlaylist(t *testing.T) {
	p := &mediaPeer{connector: connector{configuration: configuration{LocalURL: "http://127.0.0.1:8096/jellyfin"}},
		offer: offer{ItemID: "film"}, assets: make(map[string]string)}
	origin, _ := url.Parse(p.LocalURL + "/Videos/film/main.m3u8")
	playlist := "#EXTM3U\n#EXT-X-MAP:URI=\"init.mp4?api_key=secret\"\n#EXTINF:4,\n0.m4s?DeviceId=device&access_token=another\n"
	output, err := p.rewrite(origin, []byte(playlist))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(output), "secret") || strings.Count(string(output), "/samerow-direct/asset/") != 2 || len(p.assets) != 2 {
		t.Fatalf("unexpected playlist: %s", output)
	}
	for _, resource := range p.assets {
		if !strings.HasPrefix(resource, "/Videos/film/") || strings.Contains(resource, "token") || strings.Contains(resource, "api_key") {
			t.Fatalf("unexpected registered resource: %s", resource)
		}
	}
	for _, value := range []string{"http://example.com/Videos/film/file.ts", "../other/video.ts", "/jellyfin/Videos/film/%2e%2e/config", "/jellyfin/Videos/film/%252e%252e/config"} {
		if _, err := p.rewrite(origin, []byte("#EXTM3U\n"+value)); err == nil {
			t.Errorf("accepted out-of-scope path %s", value)
		}
	}
}
