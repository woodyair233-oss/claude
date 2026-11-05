// gatehouse-mcp is the stdio entry point that MCP clients (Claude Code,
// Claude Desktop, ...) launch. It does not speak SSH and holds no secrets:
// it authenticates to the running Gatehouse app over a private Unix socket
// and then relays MCP JSON-RPC bytes in both directions. All policy,
// approvals, redaction and auditing happen inside the app.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

var version = "1.0.0"

const (
	protocolVersion = 1
	bundleID        = "io.github.woodyair233.gatehouse"
	launchTimeout   = 25 * time.Second
	handshakeWait   = 10 * time.Second
)

type endpoint struct {
	Socket     string `json:"socket"`
	Token      string `json:"token"`
	PID        int    `json:"pid"`
	AppVersion string `json:"appVersion"`
	Protocol   int    `json:"protocol"`
}

type hello struct {
	Type          string `json:"type"`
	Protocol      int    `json:"protocol"`
	Token         string `json:"token"`
	BridgeVersion string `json:"bridgeVersion"`
	ParentPID     int    `json:"parentPid"`
	ParentName    string `json:"parentName,omitempty"`
	ClientLabel   string `json:"clientLabel,omitempty"`
}

type welcome struct {
	Type       string `json:"type"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	AppVersion string `json:"appVersion,omitempty"`
}

func dataDir() string {
	if v := os.Getenv("GATEHOUSE_HOME"); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = os.Getenv("HOME")
	}
	if runtime.GOOS == "darwin" {
		return filepath.Join(home, "Library", "Application Support", "Gatehouse")
	}
	if x := os.Getenv("XDG_CONFIG_HOME"); x != "" {
		return filepath.Join(x, "Gatehouse")
	}
	return filepath.Join(home, ".config", "Gatehouse")
}

func endpointPath() string { return filepath.Join(dataDir(), "run", "endpoint.json") }

func readEndpoint() (*endpoint, error) {
	raw, err := os.ReadFile(endpointPath())
	if err != nil {
		return nil, err
	}
	var ep endpoint
	if err := json.Unmarshal(raw, &ep); err != nil {
		return nil, fmt.Errorf("endpoint file is corrupt: %w", err)
	}
	if ep.Socket == "" || ep.Token == "" {
		return nil, errors.New("endpoint file is incomplete")
	}
	return &ep, nil
}

func dial() (net.Conn, *endpoint, error) {
	ep, err := readEndpoint()
	if err != nil {
		return nil, nil, err
	}
	conn, err := net.DialTimeout("unix", ep.Socket, 2*time.Second)
	if err != nil {
		return nil, ep, err
	}
	return conn, ep, nil
}

// appBundleFromExecutable returns the enclosing .app bundle when the bridge
// runs from Gatehouse.app/Contents/Resources/bin/gatehouse-mcp.
func appBundleFromExecutable() string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	idx := strings.Index(exe, ".app/Contents/")
	if idx < 0 {
		return ""
	}
	return exe[:idx+len(".app")]
}

func launchApp() error {
	if custom := os.Getenv("GATEHOUSE_APP"); custom != "" {
		cmd := exec.Command(custom)
		cmd.Stdout, cmd.Stderr = nil, nil
		return cmd.Start()
	}
	if runtime.GOOS != "darwin" {
		return errors.New("automatic launch is only supported on macOS; start Gatehouse first")
	}
	var attempts [][]string
	if bundle := appBundleFromExecutable(); bundle != "" {
		attempts = append(attempts, []string{"-g", bundle})
	}
	attempts = append(attempts, []string{"-g", "-b", bundleID}, []string{"-g", "-a", "Gatehouse"})
	var lastErr error
	for _, args := range attempts {
		if err := exec.Command("/usr/bin/open", args...).Run(); err == nil {
			return nil
		} else {
			lastErr = err
		}
	}
	return lastErr
}

func connect(allowLaunch bool) (net.Conn, *endpoint, error) {
	conn, ep, err := dial()
	if err == nil {
		return conn, ep, nil
	}
	if !allowLaunch {
		return nil, nil, err
	}
	fmt.Fprintln(os.Stderr, "gatehouse-mcp: Gatehouse is not running, launching it…")
	if lerr := launchApp(); lerr != nil {
		return nil, nil, fmt.Errorf("could not launch Gatehouse: %w", lerr)
	}
	deadline := time.Now().Add(launchTimeout)
	for time.Now().Before(deadline) {
		time.Sleep(300 * time.Millisecond)
		if conn, ep, err = dial(); err == nil {
			return conn, ep, nil
		}
	}
	return nil, nil, fmt.Errorf("Gatehouse did not start within %s: %v", launchTimeout, err)
}

func parentName(pid int) string {
	out, err := exec.Command("ps", "-o", "comm=", "-p", strconv.Itoa(pid)).Output()
	if err != nil {
		return ""
	}
	name := strings.TrimSpace(string(out))
	return filepath.Base(name)
}

func handshake(conn net.Conn, ep *endpoint, label string) (*bufio.Reader, *welcome, error) {
	h := hello{
		Type:          "hello",
		Protocol:      protocolVersion,
		Token:         ep.Token,
		BridgeVersion: version,
		ParentPID:     os.Getppid(),
		ParentName:    parentName(os.Getppid()),
		ClientLabel:   label,
	}
	line, _ := json.Marshal(h)
	_ = conn.SetDeadline(time.Now().Add(handshakeWait))
	if _, err := conn.Write(append(line, '\n')); err != nil {
		return nil, nil, fmt.Errorf("handshake write failed: %w", err)
	}
	reader := bufio.NewReaderSize(conn, 64*1024)
	resp, err := reader.ReadBytes('\n')
	if err != nil {
		return nil, nil, fmt.Errorf("handshake read failed: %w", err)
	}
	_ = conn.SetDeadline(time.Time{})
	var w welcome
	if err := json.Unmarshal(resp, &w); err != nil {
		return nil, nil, fmt.Errorf("unexpected handshake reply: %w", err)
	}
	if !w.OK {
		return nil, &w, fmt.Errorf("Gatehouse refused the connection: %s", w.Error)
	}
	return reader, &w, nil
}

func doctor() int {
	fmt.Printf("gatehouse-mcp %s (%s/%s)\n", version, runtime.GOOS, runtime.GOARCH)
	fmt.Printf("data directory: %s\n", dataDir())
	ep, err := readEndpoint()
	if err != nil {
		fmt.Printf("endpoint:       not found (%v)\n", err)
		fmt.Println("status:         Gatehouse is not running")
		return 1
	}
	fmt.Printf("endpoint:       %s (app pid %d, version %s)\n", ep.Socket, ep.PID, ep.AppVersion)
	conn, err := net.DialTimeout("unix", ep.Socket, 2*time.Second)
	if err != nil {
		fmt.Printf("status:         socket unreachable (%v)\n", err)
		return 1
	}
	defer conn.Close()
	if _, w, err := handshake(conn, ep, "doctor"); err != nil {
		fmt.Printf("status:         handshake failed (%v)\n", err)
		return 1
	} else {
		fmt.Printf("status:         OK — connected to Gatehouse %s\n", w.AppVersion)
	}
	return 0
}

func main() {
	allowLaunch := true
	label := ""
	for i := 1; i < len(os.Args); i++ {
		switch arg := os.Args[i]; {
		case arg == "--version" || arg == "-v":
			fmt.Println(version)
			return
		case arg == "--doctor":
			os.Exit(doctor())
		case arg == "--no-launch":
			allowLaunch = false
		case arg == "--label" && i+1 < len(os.Args):
			label = os.Args[i+1]
			i++
		case strings.HasPrefix(arg, "--label="):
			label = strings.TrimPrefix(arg, "--label=")
		case arg == "--help" || arg == "-h":
			fmt.Println("usage: gatehouse-mcp [--doctor] [--no-launch] [--label NAME] [--version]")
			fmt.Println("Relays MCP stdio to the Gatehouse app. Configure it as a stdio MCP server.")
			return
		}
	}

	conn, ep, err := connect(allowLaunch)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gatehouse-mcp: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	reader, _, err := handshake(conn, ep, label)
	if err != nil {
		fmt.Fprintf(os.Stderr, "gatehouse-mcp: %v\n", err)
		os.Exit(1)
	}

	// stdin -> app. When the MCP client closes stdin, half-close the socket so
	// the app sees EOF, finishes in-flight replies and closes its side.
	go func() {
		_, _ = io.Copy(conn, os.Stdin)
		if uc, ok := conn.(*net.UnixConn); ok {
			_ = uc.CloseWrite()
		} else {
			_ = conn.Close()
		}
	}()

	// app -> stdout. Returns when the app closes the connection.
	if _, err := io.Copy(os.Stdout, reader); err != nil && !errors.Is(err, net.ErrClosed) {
		fmt.Fprintf(os.Stderr, "gatehouse-mcp: connection lost: %v\n", err)
		os.Exit(1)
	}
}
