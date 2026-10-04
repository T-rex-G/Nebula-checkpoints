package main

import (
	"net/http"
	"os"
	"path/filepath"
)

func download(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("file")
	data, err := os.ReadFile(filepath.Join("/srv/files", name)) // expect: SEC-022
	if err != nil {
		http.NotFound(w, r)
		return
	}
	w.Write(data)
}

func main() {
	http.HandleFunc("/download", download)
}
