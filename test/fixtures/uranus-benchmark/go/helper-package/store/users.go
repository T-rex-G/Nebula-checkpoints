package store

import "database/sql"

var DB *sql.DB

func FindByEmail(email string) (*sql.Rows, error) {
	return DB.Query("SELECT * FROM users WHERE email = '" + email + "'") // expect: SEC-001
}
