package web

import (
	"embed"
	"io/fs"
)

//go:embed dist/*
var embedded embed.FS

func Files() fs.FS {
	files, err := fs.Sub(embedded, "dist")
	if err != nil {
		panic(err)
	}
	return files
}
