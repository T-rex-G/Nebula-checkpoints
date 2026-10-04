package main

import (
	"database/sql"
	"net/http"
	"fmt"
	"strconv"
)

var db *sql.DB

func order(w http.ResponseWriter, r *http.Request) {
	id, err := strconv.Atoi(r.URL.Query().Get("id"))
	if err != nil {
		http.Error(w, "bad id", http.StatusBadRequest)
		return
	}
	db.Query(fmt.Sprintf("SELECT * FROM orders WHERE id = %d", id))
}

func main() {
	http.HandleFunc("/order", order)
}
