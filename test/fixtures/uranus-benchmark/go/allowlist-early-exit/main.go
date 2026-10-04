package main

import (
	"database/sql"
	"net/http"
)

var db *sql.DB

func items(w http.ResponseWriter, r *http.Request) {
	sort := r.URL.Query().Get("sort")
	if sort != "name" && sort != "created_at" {
		http.Error(w, "bad sort", http.StatusBadRequest)
		return
	}
	db.Query("SELECT * FROM items ORDER BY " + sort)
}

func main() {
	http.HandleFunc("/items", items)
}
