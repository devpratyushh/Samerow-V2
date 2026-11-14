// SPDX-License-Identifier: GPL-3.0-or-later

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/webrtc/v4"
)

const frameSize = 16 * 1024
const manifestLimit = 2 * 1024 * 1024
const responseLimit = 64 * 1024 * 1024

var uriAttribute = regexp.MustCompile(`URI="([^"]+)"`)
var mediaID = regexp.MustCompile(`^[a-zA-Z0-9_-]{1,128}$`)
var byteRange = regexp.MustCompile(`^bytes=[0-9]{1,15}-[0-9]{0,15}$`)

type request struct {
	Op, Asset, Range string
	ID               uint32
}

type frame struct {
	Op      string            `json:"op"`
	ID      uint32            `json:"id"`
	Status  int               `json:"status,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

type mediaPeer struct {
	connector
	offer
	ctx      context.Context
	cancel   context.CancelFunc
	pc       *webrtc.PeerConnection
	lease    atomic.Int64
	created  time.Time
	mu       sync.Mutex
	assets   map[string]string
	requests map[uint32]context.CancelFunc
	sendMu   sync.Mutex
	low      chan struct{}
}

func (c connector) newPeer(ctx context.Context, o offer) (*mediaPeer, error) {
	if !mediaID.MatchString(o.ItemID) {
		return nil, errors.New("invalid movie")
	}
	stun := c.STUN
	if stun == "" {
		stun = "stun:stun.l.google.com:19302,stun:global.stun.twilio.com:3478"
	}
	var urls []string
	for _, addr := range strings.Split(stun, ",") {
		if strings.HasPrefix(addr, "stun:") || strings.HasPrefix(addr, "stuns:") {
			urls = append(urls, addr)
		}
	}
	var engine webrtc.SettingEngine
	engine.SetRemoteIPFilter(func(ip net.IP) bool {
		return ip.IsGlobalUnicast() && !ip.IsLoopback()
	})
	var servers []webrtc.ICEServer
	if len(urls) > 0 {
		servers = append(servers, webrtc.ICEServer{URLs: urls})
	}
	pc, err := webrtc.NewAPI(webrtc.WithSettingEngine(engine)).NewPeerConnection(webrtc.Configuration{ICEServers: servers})
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(ctx)
	p := &mediaPeer{connector: c, offer: o, ctx: ctx, cancel: cancel, pc: pc, created: time.Now(),
		assets: map[string]string{"manifest": o.Resource}, requests: make(map[uint32]context.CancelFunc), low: make(chan struct{}, 1)}
	for id, resource := range o.Subtitles {
		p.assets["subtitle/"+id] = resource
	}
	p.lease.Store(time.Now().Add(8 * time.Second).UnixMilli())
	pc.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		if state == webrtc.PeerConnectionStateFailed {
			cancel()
		}
	})
	var accepted atomic.Bool
	pc.OnDataChannel(func(dc *webrtc.DataChannel) {
		if dc.Label() != "samerow-hls-v1" || !dc.Ordered() || dc.MaxRetransmits() != nil ||
			dc.MaxPacketLifeTime() != nil || !accepted.CompareAndSwap(false, true) {
			_ = dc.Close()
			return
		}
		dc.SetBufferedAmountLowThreshold(128 * 1024)
		dc.OnBufferedAmountLow(func() {
			select {
			case p.low <- struct{}{}:
			default:
			}
		})
		dc.OnClose(cancel)
		dc.OnMessage(func(message webrtc.DataChannelMessage) { p.receive(dc, message) })
	})
	return p, nil
}

func (p *mediaPeer) answer() {
	if p.negotiate() != nil {
		p.cancel()
	}
}

func (p *mediaPeer) negotiate() error {
	if err := p.pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeOffer, SDP: p.SDP}); err != nil {
		return err
	}
	answer, err := p.pc.CreateAnswer(nil)
	if err != nil {
		return err
	}
	gathered := webrtc.GatheringCompletePromise(p.pc)
	if err := p.pc.SetLocalDescription(answer); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(p.ctx, 2800*time.Millisecond)
	defer cancel()
	select {
	case <-ctx.Done():
		if p.ctx.Err() != nil {
			return p.ctx.Err()
		}
	case <-gathered:
	}
	return p.call(p.ctx, "answer/"+p.ID, map[string]string{"sdp": p.pc.LocalDescription().SDP}, nil)
}

func (p *mediaPeer) close() {
	p.cancel()
	_ = p.pc.Close()
	// Each direct peer has its own encoding session. An old peer can only
	// stop its own encoding, even if the viewer has already switched to HTTPS.
	resource, err := url.Parse(p.Resource)
	if err != nil {
		return
	}
	session := resource.Query().Get("PlaySessionId")
	if session == "" {
		return
	}
	query := url.Values{"PlaySessionId": {session}, "DeviceId": {p.DeviceID}}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	go func() {
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, http.MethodDelete,
			strings.TrimRight(p.LocalURL, "/")+"/Videos/ActiveEncodings?"+query.Encode(), nil)
		if err == nil {
			p.setAuthorization(req)
			if response, err := p.local.Do(req); err == nil {
				_ = response.Body.Close()
			}
		}
	}()
}

func (p *mediaPeer) setAuthorization(req *http.Request) {
	req.Header.Set("Authorization", `MediaBrowser Client="SameRow", Device="SameRow Web", Version="1.0.0", DeviceId="`+p.DeviceID+`", Token="`+p.APIToken+`"`)
}

func (p *mediaPeer) authorized() bool {
	return p.ctx.Err() == nil && time.Now().UnixMilli() < p.lease.Load()
}

func (p *mediaPeer) receive(dc *webrtc.DataChannel, msg webrtc.DataChannelMessage) {
	if !msg.IsString || len(msg.Data) > 1024 || !p.authorized() {
		return
	}
	var req request
	if json.Unmarshal(msg.Data, &req) != nil || req.ID == 0 {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if req.Op == "cancel" {
		if cancel := p.requests[req.ID]; cancel != nil {
			cancel()
		}
		return
	}
	if req.Op != "get" || p.requests[req.ID] != nil {
		return
	}
	resource := p.assets[req.Asset]
	if resource == "" || (req.Range != "" && !byteRange.MatchString(req.Range)) || len(p.requests) >= 6 {
		// Cancel a peer that exceeds the protocol's bounded request window.
		p.cancel()
		return
	}
	ctx, cancel := context.WithTimeout(p.ctx, 30*time.Second)
	p.requests[req.ID] = cancel
	go func() {
		defer func() { cancel(); p.mu.Lock(); delete(p.requests, req.ID); p.mu.Unlock() }()
		if err := p.transfer(ctx, dc, req, resource); err != nil && ctx.Err() == nil {
			_ = p.control(ctx, dc, frame{Op: "error", ID: req.ID})
		}
	}()
}

func (p *mediaPeer) send(ctx context.Context, dc *webrtc.DataChannel, data []byte, control bool) error {
	// Serialize the buffer check and send across concurrent requests.
	p.sendMu.Lock()
	defer p.sendMu.Unlock()
	for dc.BufferedAmount() >= 256*1024 && p.authorized() {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-p.low:
		case <-time.After(100 * time.Millisecond):
		}
	}
	if ctx.Err() != nil || !p.authorized() {
		return context.Canceled
	}
	if control {
		return dc.SendText(string(data))
	}
	return dc.Send(data)
}

func (p *mediaPeer) control(ctx context.Context, dc *webrtc.DataChannel, value frame) error {
	buf, err := json.Marshal(value)
	if err != nil {
		return err
	}
	return p.send(ctx, dc, buf, true)
}

func (p *mediaPeer) transfer(ctx context.Context, dc *webrtc.DataChannel, req request, resource string) error {
	if !strings.HasPrefix(resource, "/Videos/"+p.ItemID+"/") {
		return errors.New("invalid resource")
	}
	local := strings.TrimRight(p.LocalURL, "/")
	upstream, err := http.NewRequestWithContext(ctx, http.MethodGet, local+resource, nil)
	if err != nil {
		return err
	}
	p.setAuthorization(upstream)
	upstream.Header.Set("Accept-Encoding", "identity")
	if req.Range != "" {
		upstream.Header.Set("Range", req.Range)
	}
	resp, err := p.local.Do(upstream)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	headers := make(map[string]string)
	for _, name := range []string{"content-type", "content-length", "content-range", "accept-ranges"} {
		if value := resp.Header.Get(name); value != "" && len(value) < 512 {
			headers[name] = value
		}
	}
	var body io.Reader = resp.Body
	if resp.StatusCode >= 200 && resp.StatusCode < 300 {
		if req.Asset == "manifest" || strings.Contains(strings.ToLower(headers["content-type"]), "mpegurl") || strings.HasSuffix(upstream.URL.Path, ".m3u8") {
			playlist, err := io.ReadAll(io.LimitReader(body, manifestLimit+1))
			if err != nil || len(playlist) > manifestLimit {
				return errors.New("playlist limit")
			}
			playlist, err = p.rewrite(upstream.URL, playlist)
			if err != nil {
				return err
			}
			headers["content-length"] = strconv.Itoa(len(playlist))
			body = bytes.NewReader(playlist)
		}
		if length, _ := strconv.ParseInt(headers["content-length"], 10, 64); length > responseLimit {
			return errors.New("response limit")
		}
	} else {
		delete(headers, "content-length")
		body = bytes.NewReader(nil)
	}
	if err := p.control(ctx, dc, frame{Op: "headers", ID: req.ID, Status: resp.StatusCode, Headers: headers}); err != nil {
		return err
	}
	buf := make([]byte, frameSize)
	binary.BigEndian.PutUint32(buf, req.ID)
	total := 0
	for seq := uint32(0); ; seq++ {
		n, err := io.ReadFull(body, buf[8:])
		total += n
		if total > responseLimit {
			return errors.New("response limit")
		}
		if n > 0 {
			binary.BigEndian.PutUint32(buf[4:], seq)
			if sendErr := p.send(ctx, dc, buf[:n+8], false); sendErr != nil {
				return sendErr
			}
		}
		if err == io.EOF || err == io.ErrUnexpectedEOF {
			break
		}
		if err != nil {
			return err
		}
	}
	return p.control(ctx, dc, frame{Op: "end", ID: req.ID})
}

func (p *mediaPeer) rewrite(origin *url.URL, playlist []byte) ([]byte, error) {
	base, err := url.Parse(p.LocalURL)
	if err != nil {
		return nil, err
	}
	prefix := strings.TrimRight(base.Path, "/") + "/Videos/" + p.ItemID + "/"
	p.mu.Lock()
	defer p.mu.Unlock()
	register := func(value string) (string, error) {
		u, err := origin.Parse(value)
		if err != nil || u.Host != origin.Host || u.Scheme != origin.Scheme || u.User != nil ||
			!strings.HasPrefix(strings.ToLower(u.Path), strings.ToLower(prefix)) ||
			strings.ContainsAny(u.Path, "%\\\x00") || strings.Contains(u.Path, "/../") || strings.Contains(u.Path, "/./") ||
			strings.HasSuffix(u.Path, "/..") || strings.HasSuffix(u.Path, "/.") || len(value) > 4096 {
			return "", errors.New("invalid playlist resource")
		}
		q := u.Query()
		for key := range q {
			switch strings.ToLower(key) {
			case "apikey", "api_key", "token", "access_token":
				q.Del(key)
			}
		}
		// Compare the decoded path above and escape its suffix anew so encoded
		// prefixes cannot affect where the Jellyfin item boundary is sliced.
		path := (&url.URL{Path: "/Videos/" + p.ItemID + "/" + u.Path[len(prefix):]}).EscapedPath()
		resource := path + "?" + q.Encode()
		sum := sha256.Sum256([]byte(resource))
		id := hex.EncodeToString(sum[:])
		if len(p.assets) >= 16000 && p.assets[id] == "" {
			return "", errors.New("asset limit")
		}
		p.assets[id] = resource
		return "/samerow-direct/asset/" + id, nil
	}
	lines := strings.Split(string(playlist), "\n")
	for i, line := range lines {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		if !strings.HasPrefix(line, "#") {
			lines[i], err = register(line)
			if err != nil {
				return nil, err
			}
		} else {
			for _, match := range uriAttribute.FindAllStringSubmatch(line, -1) {
				asset, err := register(match[1])
				if err != nil {
					return nil, err
				}
				lines[i] = strings.Replace(lines[i], match[0], `URI="`+asset+`"`, 1)
			}
		}
	}
	result := strings.Join(lines, "\n")
	if len(result) > manifestLimit {
		return nil, errors.New("playlist limit")
	}
	return []byte(result), nil
}
