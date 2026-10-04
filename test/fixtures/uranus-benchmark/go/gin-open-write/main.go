package main

import (
	"database/sql"
	"github.com/gin-gonic/gin"
)

var db *sql.DB

func main() {
	r := gin.Default()
	r.POST("/notes", func(c *gin.Context) { // expect: ACC-001
		db.Exec("INSERT INTO notes (title) VALUES ($1)", c.PostForm("title"))
		c.Status(201)
	})
	r.Run()
}
