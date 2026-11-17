package main

import (
	"net/http"
	"github.com/go-chi/chi/v5"
)

func routes(r chi.Router) {
	r.Use(authMiddleware)
	r.Get("/invoices/{id}", getInvoice) // expect: ACC-002 to-confirm
}

func getInvoice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var inv Invoice
	db.First(&inv, "id = ?", id)
	json.NewEncoder(w).Encode(inv)
}
