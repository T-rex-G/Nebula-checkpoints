package api

import (
	"net/http"

	"example.com/app/store"
)

func Lookup(w http.ResponseWriter, r *http.Request) {
	store.FindByEmail(r.URL.Query().Get("email"))
}
