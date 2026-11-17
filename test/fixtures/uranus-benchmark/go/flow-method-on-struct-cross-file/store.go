package main

import "database/sql"

type Store struct{ db *sql.DB }

func (s *Store) FindUser(name string) {
	s.db.Query("SELECT * FROM u WHERE n = '" + name + "'") // expect: SEC-001
}
