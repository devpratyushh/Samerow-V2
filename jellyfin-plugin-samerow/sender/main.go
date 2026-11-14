// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/pion/webrtc/v4"
)

type configuration struct {
	Gateway, Token, LocalURL, STUN string
}

type offer struct {
	ID, SDP, Resource, ItemID, DeviceID, APIToken string
	Subtitles                                     map[string]string
}

type connector struct {
	configuration
	cloud, local *http.Client
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	var config configuration
	if json.NewDecoder(os.Stdin).Decode(&config) != nil {
		return
	}
	// EOF also terminates the helper if Jellyfin exits without running shutdown.
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); cancel() }()
	local, err := url.Parse(config.LocalURL)
	gateway, cloudErr := url.Parse(config.Gateway)
	if err != nil || cloudErr != nil || local.Hostname() != "127.0.0.1" || local.Scheme != "http" ||
		(gateway.Scheme != "https" && !(gateway.Scheme == "http" && gateway.Hostname() == "127.0.0.1")) ||
		gateway.User != nil || gateway.RawQuery != "" || gateway.Fragment != "" {
		return
	}
	noRedirect := func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	localTransport := http.DefaultTransport.(*http.Transport).Clone()
	localTransport.Proxy = nil
	localTransport.DisableCompression = true
	c := connector{config, &http.Client{Timeout: 3 * time.Second, CheckRedirect: noRedirect},
		&http.Client{Transport: localTransport, CheckRedirect: noRedirect}}
	c.run(ctx)
}

func (c connector) call(ctx context.Context, path string, input, output any) error {
	method := http.MethodGet
	var data []byte
	if input != nil {
		method = http.MethodPost
		data, _ = json.Marshal(input)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimRight(c.Gateway, "/")+"/api/jellyfin-relay/direct/"+path, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.Token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.cloud.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode == 204 {
		return nil
	}
	if resp.StatusCode != 200 {
		return fmt.Errorf("connector status %d", resp.StatusCode)
	}
	return json.NewDecoder(io.LimitReader(resp.Body, 512*1024)).Decode(output)
}

func (c connector) run(ctx context.Context) {
	peers := make(map[string]*mediaPeer)
	defer func() {
		for _, p := range peers {
			p.close()
		}
	}()
	timer := time.NewTimer(0)
	defer timer.Stop()
	nextLease := time.Now()
	pollDelay := time.Second
	for {
		select {
		case <-ctx.Done():
			return
		case <-timer.C:
		}
		ids := make([]string, 0, len(peers))
		for id, p := range peers {
			if p.ctx.Err() != nil || (time.Since(p.created) > 20*time.Second && p.pc.ConnectionState() != webrtc.PeerConnectionStateConnected) {
				p.close()
				delete(peers, id)
			} else {
				ids = append(ids, id)
			}
		}
		if len(ids) > 0 && time.Now().After(nextLease) {
			var allowed []string
			err := c.call(ctx, "leases", map[string][]string{"ids": ids}, &allowed)
			for _, id := range ids {
				p := peers[id]
				switch {
				case err == nil && contains(allowed, id):
					p.lease.Store(time.Now().Add(8 * time.Second).UnixMilli())
				case err == nil || time.Now().UnixMilli() >= p.lease.Load():
					p.close()
					delete(peers, id)
				}
			}
			nextLease = time.Now().Add(2 * time.Second)
		}
		var offers []offer
		if c.call(ctx, "poll", nil, &offers) == nil {
			pollDelay = time.Second
			for _, o := range offers {
				if len(peers) >= 16 || peers[o.ID] != nil {
					continue
				}
				p, err := c.newPeer(ctx, o)
				if err == nil {
					peers[o.ID] = p
					go p.answer()
				}
			}
		} else if len(peers) == 0 {
			pollDelay = min(pollDelay*2, 15*time.Second)
		}
		timer.Reset(pollDelay)
	}
}

func contains(values []string, key string) bool {
	for _, value := range values {
		if value == key {
			return true
		}
	}
	return false
}
