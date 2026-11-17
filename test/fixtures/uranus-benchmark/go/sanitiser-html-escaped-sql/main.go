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
	db.Query("SELECT * FROM users WHERE name = '" + name + "'") // expect: SEC-001
}

func main() {
	http.HandleFunc("/", handle)
}
