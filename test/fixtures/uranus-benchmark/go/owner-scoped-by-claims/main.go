package main

import (
	"net/http"
	"github.com/go-chi/chi/v5"
)

func routes(r chi.Router) {
	r.Use(authMiddleware)
	r.Get("/invoices/{id}", getInvoice)
}

func getInvoice(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	userID := r.Context().Value(userKey).(string)
	var inv Invoice
	db.Where("id = ? AND user_id = ?", id, userID).First(&inv)
	json.NewEncoder(w).Encode(inv)
}
