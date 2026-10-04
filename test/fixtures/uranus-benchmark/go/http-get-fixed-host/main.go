package main

import (
	"io"
	"net/http"
	"net/url"
)

func weather(w http.ResponseWriter, r *http.Request) {
	resp, err := http.Get("https://api.weather.example.com/v1/cities/" + url.PathEscape(r.URL.Query().Get("city")))
	if err != nil {
		return
	}
	defer resp.Body.Close()
	io.Copy(w, resp.Body)
}

func main() {
	http.HandleFunc("/weather", weather)
}
