package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func items(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	if name == "" {
		name = "all"
	}
	rows, _ := db.Query("SELECT id FROM items WHERE name = '" + name + "'") // expect: SEC-001 confirmed
	defer rows.Close()
}

func main() {
	http.HandleFunc("/items", items)
	http.ListenAndServe(":8080", nil)
}
