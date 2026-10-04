package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func users(w http.ResponseWriter, r *http.Request) {
	name := r.URL.Query().Get("name")
	rows, _ := db.Query("SELECT id FROM users WHERE name = '" + name + "'") // expect: SEC-001
	defer rows.Close()
}

func main() {
	http.HandleFunc("/users", users)
	http.ListenAndServe(":8080", nil)
}
