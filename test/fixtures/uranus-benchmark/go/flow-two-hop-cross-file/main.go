package main

import "net/http"

func h(w http.ResponseWriter, r *http.Request) {
	findUser(r.URL.Query().Get("name"))
}
