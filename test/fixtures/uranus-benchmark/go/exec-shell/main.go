package main

import (
	"net/http"
	"os/exec"
)

func ping(w http.ResponseWriter, r *http.Request) {
	host := r.FormValue("host")
	out, _ := exec.Command("sh", "-c", "ping -c 1 "+host).Output() // expect: SEC-011
	w.Write(out)
}

func main() {
	http.HandleFunc("/ping", ping)
}
