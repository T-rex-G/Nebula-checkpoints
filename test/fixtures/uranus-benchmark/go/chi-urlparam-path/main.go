package main

import (
	"net/http"
	"os"
	"github.com/go-chi/chi/v5"
)

func main() {
	r := chi.NewRouter()
	r.Get("/avatars/{name}", func(w http.ResponseWriter, req *http.Request) {
		data, _ := os.ReadFile("/srv/avatars/" + chi.URLParam(req, "name")) // expect: SEC-022
		w.Write(data)
	})
	http.ListenAndServe(":8080", r)
}
