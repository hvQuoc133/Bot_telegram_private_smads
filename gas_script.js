function extractId(input) {
    if (!input) return "";
    var str = input.toString().trim();
    var match = str.match(/\/d\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    match = str.match(/\/folders\/([a-zA-Z0-9-_]+)/);
    if (match) return match[1];
    return str;
}

function extractGid(input) {
    if (!input) return null;
    var str = input.toString().trim();
    var match = str.match(/[#&?]gid=([0-9]+)/);
    if (match) return match[1];
    return null;
}

function getSheetByUrl(url) {
    var sheetId = extractId(url);
    var gid = extractGid(url);
    var spreadsheet = SpreadsheetApp.openById(sheetId);

    if (gid !== null) {
        var sheets = spreadsheet.getSheets();
        for (var i = 0; i < sheets.length; i++) {
            if (sheets[i].getSheetId().toString() === gid.toString()) {
                return sheets[i];
            }
        }
    }
    return spreadsheet.getSheets()[0];
}

function formatDate(date) {
    if (date instanceof Date) {
        var d = date.getDate();
        var m = date.getMonth() + 1;
        var y = date.getFullYear();
        return (d < 10 ? '0' + d : d) + '/' + (m < 10 ? '0' + m : m) + '/' + y;
    }
    return date ? date.toString().trim() : '';
}

function getTargetRow(sheet) {
    var lastRow = sheet.getLastRow();
    if (lastRow < 5) return 6;

    var values = sheet.getRange(6, 2, Math.max(1, lastRow - 5), 3).getValues();
    for (var i = 0; i < values.length; i++) {
        // Check if both Date (col B, index 0) and Category (col D, index 2) are empty
        if ((!values[i][0] || values[i][0] === "") && (!values[i][2] || values[i][2] === "")) {
            return i + 6;
        }
    }
    return lastRow + 1;
}

function doPost(e) {
    try {
        var data = JSON.parse(e.postData.contents);
        var action = data.action;

        if (action === 'add_expense') {
            var sheet = getSheetByUrl(data.sheetId);
            var folderId = extractId(data.folderId);
            var folder = DriveApp.getFolderById(folderId);

            var receiptUrl = "";
            var receiptUrls = [];
            if (data.receiptBase64s && data.receiptBase64s.length > 0) {
                for (var i = 0; i < data.receiptBase64s.length; i++) {
                    var blob = Utilities.newBlob(Utilities.base64Decode(data.receiptBase64s[i]), 'image/jpeg', 'Receipt_' + new Date().getTime() + '_' + i + '.jpg');
                    var file = folder.createFile(blob);
                    receiptUrls.push(file.getUrl());
                }
                receiptUrl = receiptUrls.join('\n');
            } else if (data.receiptBase64) {
                var blob = Utilities.newBlob(Utilities.base64Decode(data.receiptBase64), 'image/jpeg', 'Receipt_' + new Date().getTime() + '.jpg');
                var file = folder.createFile(blob);
                receiptUrl = file.getUrl();
            }

            var targetRow = getTargetRow(sheet);

            // B to N is 13 columns
            sheet.getRange(targetRow, 2, 1, 13).setValues([[
                data.date,       // B
                "",              // C
                data.category,   // D
                "",              // E
                data.amount,     // F
                "",              // G
                data.unit,       // H
                "",              // I
                data.payer,      // J
                "",              // K
                receiptUrl,      // L
                "",              // M
                data.notes       // N
            ]]);

            return ContentService.createTextOutput(JSON.stringify({ success: true, rowNumber: targetRow }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'update_expense') {
            var sheet = getSheetByUrl(data.sheetId);
            var rowNumber = data.rowNumber;
            var field = data.field;
            var value = data.value;

            var colIndex = 2;
            if (field === 'date') colIndex = 2; // B
            else if (field === 'category') colIndex = 4; // D
            else if (field === 'amount') colIndex = 6; // F
            else if (field === 'unit') colIndex = 8; // H
            else if (field === 'payer') colIndex = 10; // J
            else if (field === 'notes') colIndex = 14; // N

            sheet.getRange(rowNumber, colIndex).setValue(value);

            return ContentService.createTextOutput(JSON.stringify({ success: true }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'delete_expense') {
            var sheet = getSheetByUrl(data.sheetId);
            var rowNumber = data.rowNumber;

            // Clear contents instead of deleting row to avoid shifting pre-filled templates
            sheet.getRange(rowNumber, 2, 1, 13).clearContent();

            return ContentService.createTextOutput(JSON.stringify({ success: true }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'get_expenses') {
            var expenses = [];

            function readSheet(sheetUrl, costType) {
                try {
                    var sheet = getSheetByUrl(sheetUrl);
                    var values = sheet.getDataRange().getValues();
                    // Bắt đầu đọc từ dòng 6 (index 5)
                    for (var i = 5; i < values.length; i++) {
                        var row = values[i];
                        // A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13
                        // Chỉ lấy những dòng có cả Ngày (B, index 1) và Hạng mục (D, index 3)
                        if (row[1] && row[3] && row[3].toString().trim() !== "") {
                            expenses.push({
                                rowNumber: i + 1,
                                date: formatDate(row[1]),
                                category: row[3] ? row[3].toString() : '',
                                amount: row[5] ? row[5].toString() : '',
                                unit: row[7] ? row[7].toString() : '',
                                payer: row[9] ? row[9].toString() : '',
                                receiptUrl: row[11] ? row[11].toString() : '',
                                notes: row[13] ? row[13].toString() : '',
                                costType: costType
                            });
                        }
                    }
                } catch (e) {

                }
            }

            if (data.sheetFixedId) readSheet(data.sheetFixedId, 'Chi phí cố định');
            if (data.sheetNonFixedId) readSheet(data.sheetNonFixedId, 'Chi phí không cố định');

            return ContentService.createTextOutput(JSON.stringify({
                success: true,
                expenses: expenses
            })).setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'add_income') {
            var sheet = getSheetByUrl(data.sheetId);
            var folderId = extractId(data.folderId);
            var folder = DriveApp.getFolderById(folderId);

            var receiptUrl = "";
            var receiptUrls = [];
            if (data.receiptBase64s && data.receiptBase64s.length > 0) {
                for (var i = 0; i < data.receiptBase64s.length; i++) {
                    var blob = Utilities.newBlob(Utilities.base64Decode(data.receiptBase64s[i]), 'image/jpeg', 'Receipt_' + new Date().getTime() + '_' + i + '.jpg');
                    var file = folder.createFile(blob);
                    receiptUrls.push(file.getUrl());
                }
                receiptUrl = receiptUrls.join('\n');
            } else if (data.receiptBase64) {
                var blob = Utilities.newBlob(Utilities.base64Decode(data.receiptBase64), 'image/jpeg', 'Receipt_' + new Date().getTime() + '.jpg');
                var file = folder.createFile(blob);
                receiptUrl = file.getUrl();
            }

            var targetRow = getTargetRow(sheet);

            // B to R is 17 columns
            sheet.getRange(targetRow, 2, 1, 17).setValues([[
                data.date,       // B
                "",              // C
                data.category,   // D
                "",              // E
                data.bank,       // F
                "",              // G
                data.accountNum, // H
                "",              // I
                data.sender,     // J
                "",              // K
                data.amount,     // L
                "",              // M
                receiptUrl,      // N
                "",              // O
                data.notes,      // P
                "",              // Q
                ""               // R
            ]]);

            return ContentService.createTextOutput(JSON.stringify({ success: true, rowNumber: targetRow }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'update_income') {
            var sheet = getSheetByUrl(data.sheetId);
            var rowNumber = data.rowNumber;
            var field = data.field;
            var value = data.value;

            var colIndex = 2;
            if (field === 'date') colIndex = 2; // B
            else if (field === 'category') colIndex = 4; // D
            else if (field === 'bank') colIndex = 6; // F
            else if (field === 'accountNum') colIndex = 8; // H
            else if (field === 'sender') colIndex = 10; // J
            else if (field === 'amount') colIndex = 12; // L
            else if (field === 'notes') colIndex = 16; // P

            sheet.getRange(rowNumber, colIndex).setValue(value);

            return ContentService.createTextOutput(JSON.stringify({ success: true }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'delete_income') {
            var sheet = getSheetByUrl(data.sheetId);
            var rowNumber = data.rowNumber;

            sheet.getRange(rowNumber, 2, 1, 17).clearContent();

            return ContentService.createTextOutput(JSON.stringify({ success: true }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'get_incomes') {
            var incomes = [];

            function readIncomeSheet(sheetUrl, incomeType) {
                try {
                    var sheet = getSheetByUrl(sheetUrl);
                    var values = sheet.getDataRange().getValues();
                    for (var i = 5; i < values.length; i++) {
                        var row = values[i];
                        // A: 0, B: 1, C: 2, D: 3, E: 4, F: 5, G: 6, H: 7, I: 8, J: 9, K: 10, L: 11, M: 12, N: 13, O: 14, P: 15
                        if (row[1] && row[3] && row[3].toString().trim() !== "") {
                            incomes.push({
                                rowNumber: i + 1,
                                date: formatDate(row[1]),
                                category: row[3] ? row[3].toString() : '',
                                bank: row[5] ? row[5].toString() : '',
                                accountNum: row[7] ? row[7].toString() : '',
                                sender: row[9] ? row[9].toString() : '',
                                amount: row[11] ? row[11].toString() : '',
                                receiptUrl: row[13] ? row[13].toString() : '',
                                notes: row[15] ? row[15].toString() : '',
                                incomeType: incomeType
                            });
                        }
                    }
                } catch (e) {

                }
            }

            if (data.sheetRefundId) readIncomeSheet(data.sheetRefundId, 'Hoàn phí');
            if (data.sheetProjectId) readIncomeSheet(data.sheetProjectId, 'Thu dự án');

            return ContentService.createTextOutput(JSON.stringify({
                success: true,
                incomes: incomes
            })).setMimeType(ContentService.MimeType.JSON);
        }

        return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Invalid action' }))
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}
