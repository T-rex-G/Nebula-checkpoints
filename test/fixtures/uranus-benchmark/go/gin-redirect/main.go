package main

import (
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()
	r.GET("/continue", func(c *gin.Context) {
		c.Redirect(302, c.Query("next")) // expect: SEC-020
	})
	r.GET("/home", func(c *gin.Context) {
		c.Redirect(302, "/dashboard?tab="+c.Query("tab"))
	})
	r.Run()
}
