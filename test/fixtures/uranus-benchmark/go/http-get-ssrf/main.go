package main

import (
	"io"
	"net/http"
)

func preview(w http.ResponseWriter, r *http.Request) {
	resp, err := http.Get(r.URL.Query().Get("url")) // expect: SEC-021
	if err != nil {
		return
	}
	defer resp.Body.Close()
	io.Copy(w, resp.Body)
}

func main() {
	http.HandleFunc("/preview", preview)
}
