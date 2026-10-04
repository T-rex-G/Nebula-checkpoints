package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func users(w http.ResponseWriter, r *http.Request) {
	rows, _ := db.Query("SELECT id FROM users WHERE name = $1", r.URL.Query().Get("name"))
	defer rows.Close()
}

func main() {
	http.HandleFunc("/users", users)
	http.ListenAndServe(":8080", nil)
}
