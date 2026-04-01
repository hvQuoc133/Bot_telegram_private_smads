/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export default function App() {
  return (
    <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full text-center">
        <h1 className="text-3xl font-bold text-gray-800 mb-4">Telegram Bot Web App</h1>
        <p className="text-gray-600 mb-6">
          Giao diện Web App đã sẵn sàng. Bạn có thể thêm các chức năng quản lý bot tại đây.
        </p>
        <div className="bg-blue-50 text-blue-700 p-4 rounded-lg text-sm">
          <p className="font-semibold">Trạng thái hệ thống:</p>
          <ul className="text-left mt-2 space-y-1 list-disc list-inside">
            <li>React 19 + Vite</li>
            <li>Tailwind CSS v4</li>
            <li>Node.js + Express Server</li>
            <li>PostgreSQL Database</li>
            <li>Telegram Bot API</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
