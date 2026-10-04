package main

import (
	"database/sql"
	"fmt"
	"net/http"
)

type ProductStore interface {
	SearchByName(name string) (*sql.Rows, error)
}

type sqlProducts struct {
	db *sql.DB
}

func (s sqlProducts) SearchByName(name string) (*sql.Rows, error) {
	query := fmt.Sprintf("SELECT id FROM products WHERE name = '%s'", name)
	return s.db.Query(query) // expect: SEC-001
}

type Handler struct {
	products ProductStore
}

func (h Handler) search(w http.ResponseWriter, r *http.Request) {
	h.products.SearchByName(r.URL.Query().Get("name"))
}

func main() {
	h := Handler{}
	http.HandleFunc("/products", h.search)
}
