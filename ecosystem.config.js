module.exports = {
  apps: [
    {
      name: 'zalo-telegram-bridge',
      script: 'src/index.js',
      cwd: __dirname,
      // Tự restart khi crash, nhưng tránh vòng lặp crash-restart vô hạn
      autorestart: true,
      max_restarts: 20,
      min_uptime: '30s',       // nếu process chết trước 30s kể từ lúc start, tính là "lỗi liên tục"
      restart_delay: 5000,     // chờ 5s giữa các lần restart
      // Tự restart nếu RAM vượt ngưỡng (đề phòng leak trong session zca-js chạy lâu)
      max_memory_restart: '400M',
      // Restart định kỳ mỗi ngày lúc 4h sáng để làm mới session/kết nối,
      // giảm rủi ro tích tụ lỗi khi chạy liên tục nhiều ngày
      cron_restart: '0 4 * * *',
      env: {
        NODE_ENV: 'production',
      },
      out_file: './logs/out.log',
      error_file: './logs/error.log',
      merge_logs: true,
      time: true,
    },
  ],
};
