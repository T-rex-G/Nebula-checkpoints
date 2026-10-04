package main

import (
	"database/sql"
	"net/http"
	"fmt"
)

var db *sql.DB

func orders(w http.ResponseWriter, r *http.Request) {
	query := fmt.Sprintf("SELECT * FROM orders WHERE status = '%s'", r.FormValue("status"))
	db.Query(query) // expect: SEC-001
}

func main() {
	http.HandleFunc("/orders", orders)
}
