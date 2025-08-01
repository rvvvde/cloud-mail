import PostalMime from 'postal-mime';
import emailService from '../service/email-service';
import accountService from '../service/account-service';
import settingService from '../service/setting-service';
import attService from '../service/att-service';
import constant from '../const/constant';
import fileUtils from '../utils/file-utils';
import { emailConst, isDel, roleConst, settingConst } from '../const/entity-const';
import emailUtils from '../utils/email-utils';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import roleService from '../service/role-service';

dayjs.extend(utc);
dayjs.extend(timezone);

export async function email(message, env, ctx) {

	try {

		const {
			receive,
			tgBotToken,
			tgChatId,
			tgBotStatus,
			forwardStatus,
			forwardEmail,
			ruleEmail,
			ruleType,
			r2Domain
		} = await settingService.query({ env });

		if (receive === settingConst.receive.CLOSE) {
			return;
		}


		const reader = message.raw.getReader();
		let content = '';

		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			content += new TextDecoder().decode(value);
		}

		const email = await PostalMime.parse(content);

		const account = await accountService.selectByEmailIncludeDelNoCase({ env: env }, message.to);

		if (account && account.email !== env.admin) {

			let { banEmail, banEmailType, availDomain } = await roleService.selectByUserId({ env: env }, account.userId);

			if(!roleService.hasAvailDomainPerm(availDomain, message.to)) {
				return;
			}

			banEmail = banEmail.split(',').filter(item => item !== '');

			for (const item of banEmail) {

				if (item.startsWith('*@')) {

					const banDomain = emailUtils.getDomain(item.toLowerCase());
					const receiveDomain = emailUtils.getDomain(email.from.address.toLowerCase());

					if (banDomain === receiveDomain) {

						if (banEmailType === roleConst.banEmailType.ALL) return;

						if (banEmailType === roleConst.banEmailType.CONTENT) {
							email.html = 'The content has been deleted';
							email.text = 'The content has been deleted';
							email.attachments = [];
						}

					}

				} else {

					if (item.toLowerCase() === email.from.address.toLowerCase()) {

						if (banEmailType === roleConst.banEmailType.ALL) return;

						if (banEmailType === roleConst.banEmailType.CONTENT) {
							email.html = 'The content has been deleted';
							email.text = 'The content has been deleted';
							email.attachments = [];
						}

					}

				}

			}

		}

		const toName = email.to.find(item => item.address === message.to)?.name || '';

		const params = {
			toEmail: message.to,
			toName: toName,
			sendEmail: email.from.address,
			name: email.from.name || emailUtils.getName(email.from.address),
			subject: email.subject,
			content: email.html,
			text: email.text,
			cc: email.cc ? JSON.stringify(email.cc) : '[]',
			bcc: email.bcc ? JSON.stringify(email.bcc) : '[]',
			recipient: JSON.stringify(email.to),
			inReplyTo: email.inReplyTo,
			relation: email.references,
			messageId: email.messageId,
			userId: account ? account.userId : 0,
			accountId: account ? account.accountId : 0,
			isDel: isDel.DELETE,
			status: emailConst.status.SAVING
		};

		const attachments = [];
		const cidAttachments = [];

		for (let item of email.attachments) {
			let attachment = { ...item };
			attachment.key = constant.ATTACHMENT_PREFIX + await fileUtils.getBuffHash(attachment.content) + fileUtils.getExtFileName(item.filename);
			attachment.size = item.content.length ?? item.content.byteLength;
			attachments.push(attachment);
			if (attachment.contentId) {
				cidAttachments.push(attachment);
			}
		}

		let emailRow = await emailService.receive({ env }, params, cidAttachments, r2Domain);

		attachments.forEach(attachment => {
			attachment.emailId = emailRow.emailId;
			attachment.userId = emailRow.userId;
			attachment.accountId = emailRow.accountId;
		});

		if (attachments.length > 0 && env.r2) {
			await attService.addAtt({ env }, attachments);
		}

		emailRow = await emailService.completeReceive({ env }, account ? emailConst.status.RECEIVE : emailConst.status.NOONE, emailRow.emailId);


		if (ruleType === settingConst.ruleType.RULE) {

			const emails = ruleEmail.split(',');

			if (!emails.includes(message.to)) {
				return;
			}

		}


if (tgBotStatus === settingConst.tgBotStatus.OPEN && tgChatId) {

			const tgMessage = `<b>${params.subject}</b>

<b>发件人：</b>${params.name}		&lt;${params.sendEmail}&gt;
<b>收件人：\u200B</b>${message.to}
<b>时间：</b>${dayjs.utc(emailRow.createTime).tz('Asia/Shanghai').format('YYYY-MM-DD HH:mm')}

${params.text || emailUtils.htmlToText(params.content) || ''}
`;

			const tgChatIds = tgChatId.split(',');

			await Promise.all(tgChatIds.map(async chatIdStr => {
				// 跳过因为多余逗号等原因产生的无效空值
				if (!chatIdStr) return;

				try {
					let chatId = chatIdStr;
					let topicId = null;

					// 使用正则表达式来精确、安全地解析两种ID格式
					const match = chatIdStr.match(/^(-?\d+)(?:[/-](\d+))?$/);

					if (match) {
						// match[1] 总是群组ID, 例如 "-100123"
						chatId = match[1];
						// match[2] 是话题ID (如果存在)，并确保转换为数字
						if (match[2]) {
							topicId = parseInt(match[2], 10);
						}
					}

					const payload = {
						chat_id: chatId,
						parse_mode: 'HTML',
						text: tgMessage
					};

					// 确保 topicId 是一个有效的数字再加入到发送内容中
					if (topicId && !isNaN(topicId)) {
						payload.message_thread_id = topicId;
					}

					const res = await fetch(`https://api.telegram.org/bot${tgBotToken}/sendMessage`, {
						method: 'POST',
						headers: { 'Content-Type': 'application/json' },
						body: JSON.stringify(payload)
					});

					if (!res.ok) {
						// 增强日志，明确打印出Telegram返回的错误信息，方便未来排查
						const errorText = await res.text();
						console.error(`转发 Telegram 失败: Input=${chatIdStr}, Status=${res.status}, Response=${errorText}`);
					}
				} catch (e) {
					console.error(`转发 Telegram 失败: Input=${chatIdStr}`, e);
				}
			}));
		}

	} catch (e) {

		console.error('邮件接收异常: ', e);
	}
}
