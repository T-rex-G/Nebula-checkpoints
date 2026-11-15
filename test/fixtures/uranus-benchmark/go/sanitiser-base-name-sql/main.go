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
	name := filepath.Base(r.URL.Query().Get("name"))
	db.Query(fmt.Sprintf("SELECT * FROM files WHERE name = '%s'", name)) // expect: SEC-001
}

func main() {
	http.HandleFunc("/", handle)
}
