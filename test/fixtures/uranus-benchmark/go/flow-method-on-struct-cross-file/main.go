package main

import "net/http"

var store *Store

func h(w http.ResponseWriter, r *http.Request) {
	store.FindUser(r.URL.Query().Get("name"))
}
