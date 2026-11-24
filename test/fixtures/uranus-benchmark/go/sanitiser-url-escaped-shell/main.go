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
	name := url.QueryEscape(r.URL.Query().Get("name"))
	exec.Command("sh", "-c", "convert uploads/"+name+" out.png").Run() // expect: SEC-011
}

func main() {
	http.HandleFunc("/", handle)
}
