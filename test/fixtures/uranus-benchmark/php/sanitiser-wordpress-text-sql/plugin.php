<?php
$login = sanitize_text_field($_GET['login']);
$wpdb->query("SELECT * FROM wp_users WHERE user_login = '$login'"); // expect: SEC-001
