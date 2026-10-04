package main

import (
	"github.com/gin-gonic/gin"
	"gorm.io/gorm"
)

var db *gorm.DB

type User struct{ Name string }

func main() {
	r := gin.Default()
	r.GET("/users", func(c *gin.Context) {
		var users []User
		db.Where("name = '" + c.Query("name") + "'").Find(&users) // expect: SEC-001
		c.JSON(200, users)
	})
	r.Run()
}
