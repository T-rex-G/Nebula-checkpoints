package main

import (
	"net/http"
	"os/exec"
)

func ping(w http.ResponseWriter, r *http.Request) {
	out, _ := exec.Command("ping", "-c", "1", r.FormValue("host")).Output()
	w.Write(out)
}

func main() {
	http.HandleFunc("/ping", ping)
}
