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

    var values = sheet.getRange(6, 1, Math.max(1, lastRow - 5), 2).getValues();
    for (var i = 0; i < values.length; i++) {
        // Check if both Date (col 1) and Category (col 2) are empty
        if ((!values[i][0] || values[i][0] === "") && (!values[i][1] || values[i][1] === "")) {
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
            if (data.receiptBase64) {
                var blob = Utilities.newBlob(Utilities.base64Decode(data.receiptBase64), 'image/jpeg', 'Receipt_' + new Date().getTime() + '.jpg');
                var file = folder.createFile(blob);
                receiptUrl = file.getUrl();
            }

            var targetRow = getTargetRow(sheet);

            sheet.getRange(targetRow, 1, 1, 7).setValues([[
                data.date,
                data.category,
                data.amount,
                data.unit,
                data.payer,
                data.notes,
                receiptUrl
            ]]);

            return ContentService.createTextOutput(JSON.stringify({ success: true, rowNumber: targetRow }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'update_expense') {
            var sheet = getSheetByUrl(data.sheetId);
            var rowNumber = data.rowNumber;
            var field = data.field;
            var value = data.value;

            var colIndex = 1;
            if (field === 'date') colIndex = 1;
            else if (field === 'category') colIndex = 2;
            else if (field === 'amount') colIndex = 3;
            else if (field === 'unit') colIndex = 4;
            else if (field === 'payer') colIndex = 5;
            else if (field === 'notes') colIndex = 6;

            sheet.getRange(rowNumber, colIndex).setValue(value);

            return ContentService.createTextOutput(JSON.stringify({ success: true }))
                .setMimeType(ContentService.MimeType.JSON);
        }

        if (action === 'delete_expense') {
            var sheet = getSheetByUrl(data.sheetId);
            var rowNumber = data.rowNumber;

            // Clear contents instead of deleting row to avoid shifting pre-filled templates
            sheet.getRange(rowNumber, 1, 1, 7).clearContent();

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
                        // Chỉ lấy những dòng có cả Ngày và Hạng mục
                        if (row[0] && row[1] && row[1].toString().trim() !== "") {
                            expenses.push({
                                rowNumber: i + 1,
                                date: formatDate(row[0]),
                                category: row[1] ? row[1].toString() : '',
                                amount: row[2] ? row[2].toString() : '',
                                unit: row[3] ? row[3].toString() : '',
                                payer: row[4] ? row[4].toString() : '',
                                notes: row[5] ? row[5].toString() : '',
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

        return ContentService.createTextOutput(JSON.stringify({ success: false, error: 'Invalid action' }))
            .setMimeType(ContentService.MimeType.JSON);

    } catch (error) {
        return ContentService.createTextOutput(JSON.stringify({ success: false, error: error.toString() }))
            .setMimeType(ContentService.MimeType.JSON);
    }
}
