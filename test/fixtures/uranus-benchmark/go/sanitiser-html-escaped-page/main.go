package main

import (
	"database/sql"
	"fmt"
	"html"
	"net/http"
	"net/url"
	"os/exec"
	"path/filepath"
)

var db *sql.DB

func handle(w http.ResponseWriter, r *http.Request) {
	name := html.EscapeString(r.URL.Query().Get("name"))
	fmt.Fprintf(w, "<h1>Hello %s</h1>", name)
}

func main() {
	http.HandleFunc("/", handle)
}
