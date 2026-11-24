package main

import "database/sql"

var db *sql.DB

func findUser(name string) {
	db.Query("SELECT * FROM u WHERE n = '" + name + "'") // expect: SEC-001
}
