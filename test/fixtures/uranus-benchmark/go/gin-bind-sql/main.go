package main

import (
	"database/sql"
	"github.com/gin-gonic/gin"
)

var db *sql.DB

type Search struct {
	Term string `json:"term"`
}

func main() {
	r := gin.Default()
	r.POST("/search", func(c *gin.Context) {
		var body Search
		if err := c.ShouldBindJSON(&body); err != nil {
			c.AbortWithStatus(400)
			return
		}
		rows, _ := db.Query("SELECT id FROM products WHERE name LIKE '%" + body.Term + "%'") // expect: SEC-001
		defer rows.Close()
	})
	r.Run()
}
