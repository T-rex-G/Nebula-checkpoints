package main

import (
	"html/template"
	"net/http"
)

var page = template.Must(template.New("hello").Parse("<h1>Hello {{.}}</h1>"))

func hello(w http.ResponseWriter, r *http.Request) {
	page.Execute(w, r.URL.Query().Get("name"))
}

func main() {
	http.HandleFunc("/hello", hello)
}
