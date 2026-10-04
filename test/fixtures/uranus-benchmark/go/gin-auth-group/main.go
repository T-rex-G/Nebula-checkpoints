package main

import (
	"database/sql"
	"github.com/gin-gonic/gin"
)

var db *sql.DB

func AuthRequired() gin.HandlerFunc {
	return func(c *gin.Context) {
		if c.GetHeader("Authorization") == "" {
			c.AbortWithStatus(401)
		}
	}
}

func main() {
	r := gin.Default()
	private := r.Group("/api", AuthRequired())
	private.POST("/notes", func(c *gin.Context) {
		db.Exec("INSERT INTO notes (title, owner) VALUES ($1, $2)", c.PostForm("title"), c.GetString("userID"))
		c.Status(201)
	})
	r.Run()
}
