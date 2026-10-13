package main

import (
	"fmt"
	"github.com/moby/patternmatcher"
	"github.com/moby/patternmatcher/ignorefile"
	"os"
	"path/filepath"
)

func main() {
	if len(os.Args) != 2 {
		fmt.Fprintln(os.Stderr, "usage: go run . /path/to/.dockerignore")
		os.Exit(2)
	}
	file, err := os.Open(os.Args[1])
	if err != nil {
		panic(err)
	}
	defer file.Close()
	patterns, err := ignorefile.ReadAll(file)
	if err != nil {
		panic(err)
	}
	matcher, err := patternmatcher.New(patterns)
	if err != nil {
		panic(err)
	}
	keep := []string{
		"frontend/src/pages/credentials/index.tsx", "frontend/src/pages/credentials/api.ts",
		"frontend/src/pages/credentials/data/example.ts", "src/data/helper.py",
		"frontend/package.json", "frontend/package-lock.json", "frontend/tsconfig.json",
		"frontend/tsconfig.app.json", "frontend/tsconfig.node.json", "frontend/components.json",
		"frontend/vite.config.ts", "frontend/check-build.mjs", "frontend/index.html",
		"src/panel/ui.py", "web.py", "requirements.txt", "front/control_panel.html",
	}
	drop := []string{
		"creds/opaque.txt", "credentials/opaque.txt", "data/opaque.txt", "creds/credentials.db",
		".env", ".env.production", "frontend/.env.local", "custom/credential.json",
		"frontend/node_modules/example/index.js", "ui-dist/index.html", ".git/config",
		".venv/Lib/site-packages/example.py", "custom/state.sqlite3", "custom/private.pem",
	}
	for _, group := range []struct {
		paths    []string
		excluded bool
	}{{keep, false}, {drop, true}} {
		for _, name := range group.paths {
			actual, err := matcher.MatchesOrParentMatches(filepath.FromSlash(name))
			if err != nil {
				panic(err)
			}
			if actual != group.excluded {
				panic(fmt.Sprintf("%s: excluded=%v expected=%v", name, actual, group.excluded))
			}
		}
	}
	fmt.Printf("Docker Moby matcher verified: %d required paths included, %d private/dependency paths excluded.\n", len(keep), len(drop))
}
